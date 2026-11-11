import { Guard } from "./core/guard.js";
import { money } from "./core/policy.js";
import { Screener } from "./ai/screener.js";
import { SCENARIOS, materialise } from "./agent/scenarios.js";
import type { AgentAction, LedgerEntry, PendingApproval, Verdict } from "./core/types.js";

/** Firebase config comes from .env.local via Vite. See README. */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
} as Record<string, string>;

const screener = new Screener(firebaseConfig.apiKey ? firebaseConfig : null, {
  recaptchaSiteKey: import.meta.env.VITE_RECAPTCHA_SITE_KEY,
  // Debug attestation only in `npm run dev`. A production build never ships it.
  debugAppCheck: import.meta.env.DEV,
});

/**
 * The demo executor. In a real deployment this is where the action would
 * actually be handed to the agent's tool — the point of AgentGuard is that it
 * is the only path to this function.
 */
async function execute(a: AgentAction): Promise<string> {
  return `${a.kind} carried out against ${a.target}`;
}

const guard = new Guard(screener, execute);

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

// --- scenario state -------------------------------------------------------

const results = new Map<number, Verdict | "running">();

function renderScenarios(): void {
  $("scenarios").innerHTML = SCENARIOS.map((s, i) => {
    const r = results.get(i);
    const badge =
      r === "running"
        ? '<span class="verdict pendingrun">running…</span>'
        : r
          ? `<span class="verdict ${esc(r.decision)}">${esc(r.decision.replace(/_/g, " "))}</span>`
          : '<span class="verdict pendingrun">not run</span>';
    return `
      <div class="scnrow">
        <div>
          <div class="t">${esc(s.label)}</div>
          <div class="e">expected: ${esc(s.expect)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          ${badge}
          <button data-scn="${i}">Propose</button>
        </div>
      </div>`;
  }).join("");

  $("scenarios")
    .querySelectorAll<HTMLButtonElement>("button[data-scn]")
    .forEach((b) =>
      b.addEventListener("click", () => runScenario(Number(b.dataset.scn))),
    );
}

async function runScenario(i: number): Promise<void> {
  results.set(i, "running");
  renderScenarios();
  const verdict = await guard.propose(materialise(SCENARIOS[i].draft));
  results.set(i, verdict);
  renderScenarios();
  await refresh();
}

// --- rendering ------------------------------------------------------------

function renderPending(pending: PendingApproval[]): void {
  const c = $("pending-count");
  c.textContent = String(pending.length);
  c.className = "count" + (pending.length ? "" : " zero");

  if (!pending.length) {
    $("pending").innerHTML =
      '<div class="empty">Nothing held. Agents are operating inside policy.</div>';
    return;
  }

  $("pending").innerHTML = pending
    .map((p) => {
      const s = p.verdict.screening;
      const amount = p.action.amountMinor
        ? ` · ${money(p.action.amountMinor, p.action.currency)}`
        : "";
      const scope = p.action.scope > 1 ? ` · ${p.action.scope.toLocaleString()} records` : "";
      return `
      <div class="card hold">
        <div class="ctop">
          <div style="min-width:0">
            <div class="kind">${esc(p.action.kind)}${esc(amount)}${esc(scope)}</div>
            <div class="sum">${esc(p.action.summary)}</div>
            <div class="tgt">${esc(p.action.agentId)} → ${esc(p.action.target)}</div>
          </div>
          <div class="risk"><b>${s.riskScore}</b>risk</div>
        </div>
        <div class="payload">${esc(p.action.payload)}</div>
        <ul class="reasons">
          ${p.verdict.reasons.map((r) => `<li class="${esc(r.severity)}">${esc(r.message)}</li>`).join("")}
        </ul>
        <div class="assess">
          <div class="lbl">
            Screening
            <span class="pill ${esc(s.ranOn)}">${esc(label(s.ranOn))}</span>
            <span style="color:var(--faint)">confidence ${(s.confidence * 100).toFixed(0)}%</span>
          </div>
          ${esc(s.explanation)}
        </div>
        ${
          s.redactedSummary
            ? `<div class="redacted">
                 <div class="lbl">This, and only this, left your device</div>
                 <pre>${esc(s.redactedSummary)}</pre>
               </div>`
            : ""
        }
        <div class="actions">
          <button class="approve" data-ok="${esc(p.action.actionId)}">Approve &amp; run</button>
          <button class="refuse" data-no="${esc(p.action.actionId)}">Refuse</button>
        </div>
      </div>`;
    })
    .join("");

  $("pending")
    .querySelectorAll<HTMLButtonElement>("button[data-ok],button[data-no]")
    .forEach((b) =>
      b.addEventListener("click", async () => {
        const id = b.dataset.ok ?? b.dataset.no!;
        await guard.resolve(id, Boolean(b.dataset.ok));
        await refresh();
      }),
    );
}

const label = (r: string) =>
  r === "device" ? "on device" : r === "cloud" ? "cloud (redacted)" : "heuristics";

function renderLedger(entries: readonly LedgerEntry[]): void {
  if (!entries.length) {
    $("ledger").innerHTML = '<div class="empty">No activity yet.</div>';
    return;
  }
  $("ledger").innerHTML = entries
    .slice(-150)
    .reverse()
    .map(
      (e) => `
      <div class="row">
        <div class="seq">#${e.seq}</div>
        <div>
          <div class="ev ${esc(e.event)}">${esc(e.event)}</div>
          <div class="meta">${esc(describe(e))}</div>
        </div>
        <div class="time">${clock(e.at)}</div>
      </div>`,
    )
    .join("");
}

function describe(e: LedgerEntry): string {
  const p = e.payload as Record<string, never> & Record<string, unknown>;
  switch (e.event) {
    case "action_proposed":
      return `${e.agentId} · ${p.kind} · ${p.target}`;
    case "screened":
      return `${p.sensitivity} · risk ${p.riskScore} · ${label(String(p.ranOn))}${p.escalated ? " · escalated" : ""}`;
    case "policy_evaluated":
      return String(p.decision ?? "").toUpperCase().replace(/_/g, " ");
    case "approval_requested":
      return `held · risk ${p.riskScore}`;
    case "approval_granted":
      return `approved by ${p.by}`;
    case "approval_denied":
      return `refused by ${p.by}`;
    case "blocked":
      return "refused by policy — no approval possible";
    case "executed":
      return String(p.outcome ?? "");
    default:
      return "";
  }
}

async function refresh(): Promise<void> {
  const policy = guard.getPolicy();
  $("policy-text").textContent = policy.sourceText;
  $("lim-max").textContent = money(policy.limits.maxPaymentMinor);
  $("lim-appr").textContent = money(policy.limits.paymentApprovalMinor);
  $("lim-bulk").textContent = String(policy.limits.bulkScopeThreshold);
  $("lim-risk").textContent = String(policy.limits.riskApprovalThreshold);

  renderPending(guard.listPending());
  renderLedger(guard.ledger.all());

  const stopped = guard.ledger.stoppedCount();
  $("chip-stopped").textContent = `${stopped} action${stopped === 1 ? "" : "s"} stopped`;
  $("chip-stopped").className = "chip" + (stopped ? " bad" : "");

  const v = await guard.ledger.verify();
  $("chip-ledger").textContent = v.ok
    ? `ledger intact · ${v.length} entries`
    : `LEDGER BROKEN at #${v.brokenAtSeq}`;
  $("chip-ledger").className = "chip " + (v.ok ? "ok" : "bad");
}

function setDeviceChip(text: string, on = false): void {
  $("chip-device").textContent = text;
  $("chip-device").className = "chip" + (on ? " on" : "");
}

// --- boot -----------------------------------------------------------------

if (!screener.configured) {
  const el = $("setup");
  el.style.display = "block";
  el.innerHTML =
    "<b>No Firebase config found.</b> AgentGuard is running on built-in heuristics — every rule still enforces, but the on-device model is not being used. " +
    "Copy <code>.env.example</code> to <code>.env.local</code> and add your Firebase web app keys, then reload.";
  setDeviceChip("heuristics only");
  ($("btn-enable") as HTMLButtonElement).disabled = true;
} else {
  setDeviceChip("on-device: not started");
}

$("btn-enable").addEventListener("click", async () => {
  const btn = $("btn-enable") as HTMLButtonElement;
  btn.disabled = true;
  setDeviceChip("on-device: starting…");
  const ok = await screener.warmUp((pct) => setDeviceChip(`downloading model ${pct}%`));
  if (ok) {
    setDeviceChip("on-device: ready", true);
    btn.textContent = "On-device screening active";
  } else {
    setDeviceChip("on-device unavailable — cloud only");
    btn.disabled = false;
    btn.textContent = "Retry on-device screening";
  }
});

$("btn-run").addEventListener("click", async () => {
  const btn = $("btn-run") as HTMLButtonElement;
  btn.disabled = true;
  // Reset first, so a second run does not stack duplicate approvals on top of
  // the first. The demo has to be repeatable to be worth recording.
  guard.reset();
  results.clear();
  renderScenarios();
  for (let i = 0; i < SCENARIOS.length; i++) await runScenario(i);
  btn.disabled = false;
});

$("btn-clear").addEventListener("click", async () => {
  guard.reset();
  results.clear();
  renderScenarios();
  await refresh();
});

renderScenarios();
void refresh();
