import { initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  type GenerativeModel,
} from "firebase/ai";
import { redact, looksClean, hasCredentials } from "./redact.js";
import type { ActionKind, AgentAction, Screening, Sensitivity } from "../core/types.js";

/**
 * The hybrid screener.
 *
 * Every action is screened on-device first. The on-device model sees the real
 * payload — emails, SQL, shell commands, customer records — and that content
 * never leaves the machine. The cloud is consulted for a second opinion only in
 * a few defined cases (see `escalationReason`), and then it receives a redacted
 * summary, not the payload. Redaction is pattern-based, so the cloud still sees
 * a redacted version of the action; anything that carried credential material is
 * never escalated at all.
 *
 * Routine screening has to be free, instant and private, or nobody will run it
 * on every action. Hard cases are rare and worth a round trip.
 *
 * The screener is advisory in both modes. It never decides allow or deny —
 * that stays in the deterministic policy engine. A model that can be argued
 * into permitting an action is not a control, and an agent under prompt
 * injection will try exactly that argument.
 */

const SENSITIVITIES: Sensitivity[] = [
  "routine",
  "customer_data",
  "financial",
  "destructive",
  "public_facing",
  "credentials",
];

/** Least to most severe; used to resolve a muddled multi-value answer. */
const SEVERITY: Sensitivity[] = [
  "routine",
  "customer_data",
  "public_facing",
  "financial",
  "destructive",
  "credentials",
];

/**
 * Measured on a Chrome "Very Low" performance class device: a real screening
 * prompt takes 15-30s on-device, and 20s timed out every call. A timed-out call
 * is not cancelled and keeps the model busy, so it is not retried.
 */
const MODEL_TIMEOUT_MS = 90_000;

/** Below this, the on-device judgement is not trusted on its own. */
const ESCALATE_BELOW_CONFIDENCE = 0.7;

/**
 * Action kinds whose nature is known to the guard without asking any model.
 * If the on-device label contradicts what the action type implies, the small
 * model got something wrong that we can see, and a second opinion is warranted.
 *
 * This is a consistency check against deterministic data, not a second guess at
 * the model's certainty. It exists because the model's self-reported confidence
 * turned out to be coarse (only 0.7, 0.8 and 0.9 were ever observed) while its
 * labels were visibly wrong on some actions, such as calling `rm -rf` public.
 */
const EXPECTED_SENSITIVITY: Partial<Record<ActionKind, Sensitivity>> = {
  delete_file: "destructive",
  modify_database: "destructive",
  post_public: "public_facing",
  make_payment: "financial",
};

const INSTRUCTION = `You screen actions that an AI agent wants to perform on a user's behalf.

Reply with ONLY a JSON object, no prose, in exactly this shape:
{"sensitivity":"<one value>","risk_score":<number 0-100>,"confidence":<number 0.0-1.0>,"explanation":"<at most 20 words>"}

sensitivity must be exactly ONE of: routine, customer_data, financial, destructive, public_facing, credentials. Pick the single best fit; never list more than one.

risk_score is higher when the action is hard to undo, touches many people, moves
money, exposes private data, or reaches production systems. confidence is how
sure you are of your own judgement — be honest and score low when the action is
ambiguous or you lack context.

Never recommend approving or denying. Describe what the action is and what
stands out about it.`;

export interface ScreenerOptions {
  recaptchaSiteKey?: string;
  debugAppCheck?: boolean;
  /**
   * Testing only. Treats every on-device result as needing a second opinion so
   * the cloud path can be exercised on demand. The UI must say so whenever it
   * is on; a forced run must never be mistaken for a natural one.
   */
  forceEscalate?: boolean;
}

export class Screener {
  private model: GenerativeModel | null = null;
  private app: FirebaseApp | null = null;
  private readonly forceEscalate: boolean;

  /** Did Firebase config load? Without it, screening runs on heuristics. */
  readonly configured: boolean;

  constructor(firebaseConfig: Record<string, string> | null, opts: ScreenerOptions = {}) {
    this.configured = Boolean(firebaseConfig?.apiKey);
    this.forceEscalate = Boolean(opts.forceEscalate);
    if (!firebaseConfig?.apiKey) return;

    this.app = initializeApp(firebaseConfig);

    // Firebase AI Logic can enforce App Check. On localhost there is no real
    // attestation, so a debug token is used instead — set before
    // initializeAppCheck or it is ignored. The token prints to the console on
    // first run and has to be registered in the Firebase console once.
    if (opts.recaptchaSiteKey) {
      try {
        if (opts.debugAppCheck) {
          (self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
        }
        initializeAppCheck(this.app, {
          provider: new ReCaptchaV3Provider(opts.recaptchaSiteKey),
          isTokenAutoRefreshEnabled: true,
        });
      } catch {
        // Already initialised, or misconfigured. Inference will surface the
        // real error; failing here would hide it behind a blank screen.
      }
    }

    const ai = getAI(this.app, { backend: new GoogleAIBackend() });

    // ONLY_ON_DEVICE, deliberately, not PREFER_ON_DEVICE.
    //
    // PREFER_ON_DEVICE falls back to the cloud silently when no local model is
    // available — and pass one carries the real, unredacted payload. On a
    // machine without Gemini Nano that would ship exactly the data this tool
    // exists to keep local. The weaker guarantee is not worth the convenience:
    // with no device model, screening drops to heuristics and every rule still
    // runs. The cloud is reached only from the redacted escalation path.
    this.model = getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE });
  }

  /**
   * Must be called from a user gesture (a click), per the Prompt API. Kicks off
   * the on-device model download if it is not already present.
   */
  async warmUp(onProgress?: (pct: number) => void): Promise<boolean> {
    if (!this.model) return false;
    try {
      await this.model.initializeDeviceModel((v: number) =>
        onProgress?.(Math.round(v * 10000) / 100),
      );
      return true;
    } catch {
      // No device model. Screening will use heuristics; the cloud is NOT used
      // for pass one, so the unredacted payload still never leaves the machine.
      return false;
    }
  }

  /** Serialises screening. Concurrent calls to the on-device model collide. */
  private queue: Promise<unknown> = Promise.resolve();

  screen(action: AgentAction): Promise<Screening> {
    const next = this.queue.then(() => this.screenNow(action));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async screenNow(action: AgentAction): Promise<Screening> {
    if (!this.model) return heuristic(action, this.lastError);

    // --- Pass one: on device, with the real payload. ---
    const local = await this.ask(describe(action, { redacted: false }));
    if (!local) return heuristic(action, this.lastError);

    // Pass one runs ONLY_ON_DEVICE, so a result here is always from the device.
    const reason = this.escalationReason(action, local);
    if (!reason) return { ...local, ranOn: "device", escalated: false };

    // --- Pass two: a second opinion is warranted. Redact, then escalate. ---
    const { text: safeSummary, removed } = redact(describe(action, { redacted: true }));

    if (hasCredentials(removed)) {
      // Credential material never leaves the device, redacted or not. The
      // policy engine refuses these on its own; the cloud adds nothing.
      return {
        ...local,
        ranOn: "device",
        escalated: false,
        explanation:
          local.explanation +
          " (Not escalated: this action contains credential material, which stays on the device.)",
      };
    }

    if (!looksClean(safeSummary)) {
      // Redaction did not come out clean. Keep the local answer rather than
      // risk sending an identifier off the device.
      return {
        ...local,
        ranOn: "device",
        escalated: false,
        explanation:
          local.explanation +
          " (Escalation was skipped: the summary could not be redacted safely.)",
      };
    }

    const cloud = await this.ask(safeSummary, { forceCloud: true });
    if (!cloud) {
      return { ...local, ranOn: "device", escalated: false };
    }

    const removedNote = Object.entries(removed)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");

    return {
      ...cloud,
      ranOn: "cloud",
      escalated: true,
      escalationReason: reason,
      redactedSummary: safeSummary,
      explanation:
        cloud.explanation +
        (removedNote ? ` Redacted before leaving the device: ${removedNote}.` : ""),
    };
  }

  /**
   * Why, if at all, the cloud should be consulted. Returns plain words for the
   * operator to read, or null for "the local answer stands".
   */
  private escalationReason(
    action: AgentAction,
    local: Omit<Screening, "ranOn" | "escalated">,
  ): string | null {
    if (this.forceEscalate) return "escalation forced for testing";

    if (local.confidence < ESCALATE_BELOW_CONFIDENCE) {
      return `the on-device model was unsure (confidence ${Math.round(local.confidence * 100)}%)`;
    }

    const expected = EXPECTED_SENSITIVITY[action.kind];
    if (expected && local.sensitivity !== expected) {
      return `the on-device label (${local.sensitivity}) did not match the action type (${action.kind.replace(/_/g, " ")})`;
    }

    return null;
  }

  /** Why the last on-device screening fell back, if it did. Surfaced for debugging. */
  lastError: string | null = null;

  private async ask(
    body: string,
    opts: { forceCloud?: boolean } = {},
  ): Promise<Omit<Screening, "ranOn" | "escalated"> | null> {
    if (!this.model) return null;

    let model = this.model;
    if (opts.forceCloud && this.app) {
      const ai = getAI(this.app, { backend: new GoogleAIBackend() });
      model = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD });
    }

    let lastError: string | null = null;

    // Two attempts. The on-device model intermittently rejects a request when
    // several are issued close together, and a single retry clears most of it.
    // Without the retry the guard silently drops to heuristics, which looks
    // like the model is unavailable when it is merely busy.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await withTimeout(
          model.generateContent(`${INSTRUCTION}\n\n${body}`),
          MODEL_TIMEOUT_MS,
          "model call timed out",
        );
        const parsed = parse(result.response.text());
        if (parsed) {
          if (!opts.forceCloud) this.lastError = null;
          return parsed;
        }
        lastError = "model returned unparseable output";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      // Retrying after a timeout would queue behind the call still running.
      if (lastError === "model call timed out") break;
      if (attempt === 1) await sleep(400);
    }

    // Swallowing this silently is what made the earlier fallbacks impossible to
    // diagnose. The guard still degrades safely; it just says why now.
    if (opts.forceCloud) {
      console.warn("[AgentGuard] cloud escalation failed; keeping the on-device result:", lastError);
    } else {
      this.lastError = lastError;
      console.warn("[AgentGuard] screening fell back to heuristics:", lastError);
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A hung model call must not park an action in "running" forever. On timeout
 * the screener falls back to heuristics, which still enforces every rule.
 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function describe(a: AgentAction, opts: { redacted: boolean }): string {
  // The redacted variant leaves out the exact target, which is usually an
  // address or a host. Everything else still goes through `redact()` before it
  // is sent anywhere; the amount, for one, becomes a bucket there.
  return [
    `Action: ${a.kind}`,
    `Agent: ${a.agentId}`,
    `Summary: ${a.summary}`,
    opts.redacted ? null : `Target: ${a.target}`,
    `Records or recipients affected: ${a.scope}`,
    a.amountMinor > 0 ? `Amount: ${(a.amountMinor / 100).toFixed(2)} ${a.currency}` : null,
    `Content:\n${a.payload}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function parse(raw: string): Omit<Screening, "ranOn" | "escalated"> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  // A small model sometimes echoes the option list ("a|b") instead of picking
  // one. Take every valid value it named and keep the most severe, so a
  // muddled answer errs toward caution rather than collapsing to "routine".
  const named = String(obj.sensitivity ?? "")
    .toLowerCase()
    .split(/[^a-z_]+/)
    .filter((w): w is Sensitivity => SENSITIVITIES.includes(w as Sensitivity));
  const sensitivity: Sensitivity = named.length
    ? named.reduce((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a))
    : "routine";

  return {
    sensitivity,
    riskScore: clamp(Number(obj.risk_score), 0, 100, 50),
    confidence: clamp(Number(obj.confidence), 0, 1, 0.5),
    explanation:
      typeof obj.explanation === "string" && obj.explanation.trim()
        ? obj.explanation.trim()
        : "No explanation returned.",
  };
}

/** Used when no model is available. Keeps the guard enforcing rather than failing open. */
function heuristic(a: AgentAction, why: string | null = null): Screening {
  const payload = `${a.summary} ${a.payload}`.toLowerCase();

  let sensitivity: Sensitivity = "routine";
  if (/\bsk-|api[_ ]key|password|token|secret/.test(payload)) sensitivity = "credentials";
  else if (a.kind === "delete_file" || a.kind === "modify_database") sensitivity = "destructive";
  else if (a.kind === "post_public") sensitivity = "public_facing";
  else if (a.amountMinor > 0 || a.kind === "make_payment") sensitivity = "financial";
  else if (/@|customer|user|account/.test(payload)) sensitivity = "customer_data";

  const risk =
    (sensitivity === "credentials" ? 90 : 0) +
    (sensitivity === "destructive" ? 55 : 0) +
    (sensitivity === "public_facing" ? 40 : 0) +
    Math.min(30, Math.round(a.amountMinor / 100 / 20)) +
    Math.min(25, a.scope);

  return {
    sensitivity,
    riskScore: clamp(risk, 0, 100, 50),
    confidence: 0.4,
    explanation:
      `${a.agentId} wants to ${a.kind.replace(/_/g, " ")} affecting ${a.scope} record(s) at ${a.target}. ` +
      `Screened without a model, using built-in heuristics.` +
      (why ? ` Reason: ${why}.` : ""),
    ranOn: "heuristics",
    escalated: false,
  };
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
