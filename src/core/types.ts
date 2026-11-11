/**
 * AgentGuard core types.
 *
 * The model: an AI agent proposes an action. AgentGuard screens it on-device,
 * evaluates it against a deterministic policy, writes the outcome to a
 * tamper-evident ledger, and only then lets it through — or holds it for a
 * human, or refuses it outright.
 */

/** The kinds of thing an agent can try to do on your behalf. */
export type ActionKind =
  | "send_email"
  | "post_public"
  | "make_payment"
  | "delete_file"
  | "modify_database"
  | "run_command"
  | "http_request";

export type Decision = "allow" | "deny" | "require_approval";

/** What the screener judged the action to be about. */
export type Sensitivity =
  | "routine"
  | "customer_data"
  | "financial"
  | "destructive"
  | "public_facing"
  | "credentials";

export interface AgentAction {
  actionId: string;
  agentId: string;
  kind: ActionKind;
  /** One-line summary of what the agent wants to do. */
  summary: string;
  /**
   * The actual content: email body, SQL, shell command, request payload.
   * This is the part that must never reach the cloud unredacted.
   */
  payload: string;
  /** Who or what is on the receiving end: address, table, host, path. */
  target: string;
  /** Minor units. Zero for actions that move no money. */
  amountMinor: number;
  currency: string;
  /** How many records or recipients this touches, when known. */
  scope: number;
  proposedAt: string;
}

export interface Reason {
  ruleId: string;
  message: string;
  severity: "info" | "warn" | "block";
}

/** The screener's read on an action. Advisory — it never decides. */
export interface Screening {
  sensitivity: Sensitivity;
  /** 0-100. */
  riskScore: number;
  /** 0-1. The model's own certainty. Low values are one reason to escalate. */
  confidence: number;
  explanation: string;
  /** Where the judgement came from. Surfaced in the UI and the ledger. */
  ranOn: "device" | "cloud" | "heuristics";
  /** True when the cloud was consulted for a second opinion. */
  escalated: boolean;
  /** Why the cloud was consulted, in plain words. Set only when `escalated`. */
  escalationReason?: string;
  /** What was actually sent to the cloud, if anything. Shown to the user. */
  redactedSummary?: string;
}

export interface Verdict {
  decision: Decision;
  reasons: Reason[];
  screening: Screening;
}

export type LedgerEvent =
  | "action_proposed"
  | "screened"
  | "policy_evaluated"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "executed"
  | "blocked";

export interface LedgerEntry {
  seq: number;
  actionId: string;
  agentId: string;
  event: LedgerEvent;
  payload: Record<string, unknown>;
  at: string;
  prevHash: string;
  hash: string;
}

export interface PendingApproval {
  action: AgentAction;
  verdict: Verdict;
  requestedAt: string;
}
