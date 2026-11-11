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
  /** Risk at or above this needs a human regardless of anything else. */
  riskApprovalThreshold: number;
}

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
}

export type Rule = ActionRule | SensitivityRule | TargetRule | ContentRule;

const RANK: Record<Decision, number> = { allow: 0, require_approval: 1, deny: 2 };
const strongest = (a: Decision, b: Decision) => (RANK[a] >= RANK[b] ? a : b);

export interface EvalInput {
  action: AgentAction;
  sensitivity: Sensitivity;
  riskScore: number;
}

export function evaluate(
  policy: Policy,
  { action, sensitivity, riskScore }: EvalInput,
): { decision: Decision; reasons: Reason[] } {
  const reasons: Reason[] = [];
  let decision: Decision = "allow";

  const { limits } = policy;

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

  if (riskScore >= limits.riskApprovalThreshold) {
    decision = strongest(decision, "require_approval");
    reasons.push({
      ruleId: "limit:risk",
      severity: "warn",
      message: `Screened at risk ${riskScore}/100, at or over the ${limits.riskApprovalThreshold} threshold.`,
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
      return rule.patterns.some((x) => p.includes(x.toLowerCase()));
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
    "Anything the screener scores 70 or above needs a human.",
  ].join("\n"),
  limits: {
    // The ceiling sits well above the approval point on purpose: the band
    // between them is where a human decides. Equal values would mean nothing is
    // ever held, and the approval path would be dead code.
    maxPaymentMinor: 2_000_00,
    paymentApprovalMinor: 200_00,
    bulkScopeThreshold: 25,
    riskApprovalThreshold: 70,
  },
  rules: [
    {
      id: "no-secrets-in-payloads",
      type: "content",
      description:
        "This action's content looks like it contains a credential. Refused outright.",
      patterns: ["sk-", "api_key", "api key", "password:", "secret_key", "bearer ey", "-----begin"],
      effect: "deny",
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
