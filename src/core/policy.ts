import type {
  ActionKind,
  AgentAction,
  Decision,
  Reason,
  Sensitivity,
} from "./types.js";

/**
 * The deterministic half of AgentGuard.
 *
 * No network, no model, no randomness: the same action and the same screening
 * always produce the same verdict. That property is what makes the ledger worth
 * keeping — an entry can be re-derived and checked later.
 */

export interface Policy {
  version: number;
  /** The plain English the operator wrote. Displayed as-is. */
  sourceText: string;
  limits: Limits;
  rules: Rule[];
}

export interface Limits {
  /** Hard ceiling on a single payment, minor units. Nothing exceeds this. */
  maxPaymentMinor: number;
  /** At or above this, a human decides. Must sit below maxPaymentMinor. */
  paymentApprovalMinor: number;
  /** Actions touching more than this many records/recipients need a human. */
  bulkScopeThreshold: number;
}

/**
 * The screener's risk score is deliberately NOT a limit. It varies from run to
 * run on the same action (20, 40 and 25 were all observed), so a threshold on it
 * would flip verdicts at random near the line. It is shown to the human as
 * advice and never consulted here.
 */

interface BaseRule {
  id: string;
  description: string;
  effect: Decision;
}

export interface ActionRule extends BaseRule {
  type: "action";
  kinds: ActionKind[];
}

export interface SensitivityRule extends BaseRule {
  type: "sensitivity";
  levels: Sensitivity[];
}

export interface TargetRule extends BaseRule {
  type: "target";
  /** Lowercased substrings matched against the action's target. */
  patterns: string[];
}

export interface ContentRule extends BaseRule {
  type: "content";
  /** Lowercased substrings matched against the payload. */
  patterns: string[];
  /** Case-insensitive regular expressions matched against the payload. */
  regexes?: string[];
}

export type Rule = ActionRule | SensitivityRule | TargetRule | ContentRule;

const RANK: Record<Decision, number> = { allow: 0, require_approval: 1, deny: 2 };
const strongest = (a: Decision, b: Decision) => (RANK[a] >= RANK[b] ? a : b);

export interface EvalInput {
  action: AgentAction;
  sensitivity: Sensitivity;
}

export function evaluate(
  policy: Policy,
  { action, sensitivity }: EvalInput,
): { decision: Decision; reasons: Reason[] } {
  const reasons: Reason[] = [];
  let decision: Decision = "allow";

  const { limits } = policy;

  // Comparisons against NaN or undefined are all false, which would skip every
  // limit below and let the action through. Refuse malformed numbers outright.
  const validNumber = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!validNumber(action.amountMinor) || !validNumber(action.scope)) {
    return {
      decision: "deny",
      reasons: [
        {
          ruleId: "limit:invalid-input",
          severity: "block",
          message: "The amount or record count on this action is missing or not a valid number. Refused.",
        },
      ],
    };
  }

  if (action.amountMinor > limits.maxPaymentMinor) {
    decision = strongest(decision, "deny");
    reasons.push({
      ruleId: "limit:max-payment",
      severity: "block",
      message: `${money(action.amountMinor, action.currency)} is over the hard payment ceiling of ${money(limits.maxPaymentMinor, action.currency)}. No approval can override this.`,
    });
  } else if (action.amountMinor >= limits.paymentApprovalMinor) {
    decision = strongest(decision, "require_approval");
    reasons.push({
      ruleId: "limit:payment-approval",
      severity: "warn",
      message: `Payments at or above ${money(limits.paymentApprovalMinor, action.currency)} need a human.`,
    });
  }

  if (action.scope > limits.bulkScopeThreshold) {
    decision = strongest(decision, "require_approval");
    reasons.push({
      ruleId: "limit:bulk-scope",
      severity: "warn",
      message: `This touches ${action.scope} records or recipients, over the bulk threshold of ${limits.bulkScopeThreshold}.`,
    });
  }

  for (const rule of policy.rules) {
    if (!matches(rule, action, sensitivity)) continue;
    decision = strongest(decision, rule.effect);
    reasons.push({
      ruleId: rule.id,
      severity:
        rule.effect === "deny" ? "block" : rule.effect === "require_approval" ? "warn" : "info",
      message: rule.description,
    });
  }

  if (reasons.length === 0) {
    reasons.push({
      ruleId: "default-allow",
      severity: "info",
      message: "No rule or limit applies.",
    });
  }

  return { decision, reasons };
}

function matches(rule: Rule, action: AgentAction, sensitivity: Sensitivity): boolean {
  switch (rule.type) {
    case "action":
      return rule.kinds.includes(action.kind);
    case "sensitivity":
      return rule.levels.includes(sensitivity);
    case "target": {
      const t = action.target.toLowerCase();
      return rule.patterns.some((p) => t.includes(p.toLowerCase()));
    }
    case "content": {
      const p = action.payload.toLowerCase();
      return (
        rule.patterns.some((x) => p.includes(x.toLowerCase())) ||
        (rule.regexes ?? []).some((x) => new RegExp(x, "i").test(action.payload))
      );
    }
  }
}

export function money(minor: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  sourceText: [
    "Agents may send routine emails and make small payments on their own.",
    "Payments from $200 up need a human. Nothing over $2,000, ever.",
    "Anything touching more than 25 records or recipients needs a human.",
    "Never delete files or drop database tables — hold those for a human.",
    "Never post anything publicly without a human reading it first.",
    "Never send anything containing an API key, password or token.",
    "Shell commands and outbound requests need a human.",
    "The screener's risk score is advice for the human. It never decides.",
  ].join("\n"),
  limits: {
    // The ceiling sits well above the approval point on purpose: the band
    // between them is where a human decides. Equal values would mean nothing is
    // ever held, and the approval path would be dead code. `assertPolicy`
    // enforces it.
    maxPaymentMinor: 2_000_00,
    paymentApprovalMinor: 200_00,
    bulkScopeThreshold: 25,
  },
  rules: [
    {
      id: "no-secrets-in-payloads",
      type: "content",
      description:
        "This action's content looks like it contains a credential. Refused outright.",
      patterns: ["api_key", "api key", "secret_key", "-----begin", "authorization:"],
      regexes: [
        "\\bsk-[a-z0-9_-]{8,}",
        "\\bbearer\\s+\\S{6,}",
        "\\b(?:password|passwd|pwd)\\s*[:=]\\s*\\S+",
        "\\b(?:akia|asia)[a-z0-9]{16}\\b",
        "\\baiza[a-z0-9_-]{20,}",
        "\\b(?:glpat|ghp|gho|ghs|xoxb|xoxp)[-_][a-z0-9_-]{12,}",
        "\\btoken\\s*[:=]\\s*\\S{6,}",
      ],
      effect: "deny",
    },
    {
      id: "commands-and-requests-need-human",
      type: "action",
      description:
        "Shell commands and outbound requests are not covered by a finer rule, so a human decides.",
      kinds: ["run_command", "http_request"],
      effect: "require_approval",
    },
    {
      id: "destructive-needs-human",
      type: "action",
      description: "Deleting files or modifying the database always needs a human.",
      kinds: ["delete_file", "modify_database"],
      effect: "require_approval",
    },
    {
      id: "public-needs-human",
      type: "action",
      description: "Anything posted publicly must be read by a human first.",
      kinds: ["post_public"],
      effect: "require_approval",
    },
    {
      id: "prod-targets",
      type: "target",
      description: "Production systems are off limits to agents without approval.",
      patterns: ["prod", "production", "live-db"],
      effect: "require_approval",
    },
    {
      id: "credentials-sensitivity",
      type: "sensitivity",
      description: "The screener flagged credential material in this action.",
      levels: ["credentials"],
      effect: "deny",
    },
  ],
};

/**
 * Structural checks a policy must pass before it is ever used. The ceiling has
 * to sit strictly above the approval point: if they were equal, the band where a
 * human decides would collapse to a single value and the approval path would be
 * effectively dead. This was a real bug once.
 */
export function assertPolicy(p: Policy): void {
  const { maxPaymentMinor, paymentApprovalMinor, bulkScopeThreshold } = p.limits;
  const ok = (n: number) => Number.isFinite(n) && n >= 0;
  if (![maxPaymentMinor, paymentApprovalMinor, bulkScopeThreshold].every(ok)) {
    throw new Error("Policy limits must be finite, non-negative numbers.");
  }
  if (paymentApprovalMinor >= maxPaymentMinor) {
    throw new Error("Policy invalid: the approval threshold must be below the hard payment ceiling.");
  }
}

assertPolicy(DEFAULT_POLICY);
