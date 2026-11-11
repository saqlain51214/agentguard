import { Ledger } from "./ledger.js";
import { DEFAULT_POLICY, evaluate, type Policy } from "./policy.js";
import type { Screener } from "../ai/screener.js";
import { redact } from "../ai/redact.js";
import type { AgentAction, PendingApproval, Verdict } from "./types.js";

/**
 * The single chokepoint.
 *
 * Every action an agent proposes goes through `propose()`, and the only way an
 * action is ever executed is from inside this class. That is what makes the
 * audit trail complete by construction rather than by everyone remembering to
 * log things.
 */
/**
 * What the ledger is allowed to remember about the other end of an action.
 * Targets and summaries are often identifiers themselves (an email address, a
 * customer-facing path), and the ledger persists in storage, so they are
 * redacted here the same way text bound for the cloud is.
 */
const safe = (s: string) => redact(s).text;

export class Guard {
  readonly ledger = new Ledger();
  private policy: Policy = DEFAULT_POLICY;
  private pending = new Map<string, PendingApproval>();

  constructor(
    private readonly screener: Screener,
    /** Called when an action is cleared to run. Returns what happened. */
    private readonly executor: (a: AgentAction) => Promise<string>,
  ) {}

  getPolicy(): Policy {
    return this.policy;
  }

  setPolicy(p: Policy): void {
    this.policy = { ...p, version: this.policy.version + 1 };
  }

  /** Clears the ledger and the approval queue, for a repeatable demo. */
  reset(): void {
    this.ledger.clear();
    this.pending.clear();
  }

  listPending(): PendingApproval[] {
    return [...this.pending.values()].sort((a, b) =>
      b.requestedAt.localeCompare(a.requestedAt),
    );
  }

  async propose(action: AgentAction): Promise<Verdict> {
    await this.ledger.append({
      actionId: action.actionId,
      agentId: action.agentId,
      event: "action_proposed",
      payload: {
        kind: action.kind,
        summary: safe(action.summary),
        target: safe(action.target),
        scope: action.scope,
        amountMinor: action.amountMinor,
        currency: action.currency,
      },
    });

    const screening = await this.screener.screen(action);

    await this.ledger.append({
      actionId: action.actionId,
      agentId: action.agentId,
      event: "screened",
      payload: {
        sensitivity: screening.sensitivity,
        riskScore: screening.riskScore,
        confidence: screening.confidence,
        ranOn: screening.ranOn,
        escalated: screening.escalated,
        escalationReason: screening.escalationReason ?? null,
        // The redacted summary is recorded precisely because it is what left
        // the device. The raw payload is never written to the ledger.
        redactedSummary: screening.redactedSummary ?? null,
      },
    });

    const { decision, reasons } = evaluate(this.policy, {
      action,
      sensitivity: screening.sensitivity,
    });

    const verdict: Verdict = { decision, reasons, screening };

    await this.ledger.append({
      actionId: action.actionId,
      agentId: action.agentId,
      event: "policy_evaluated",
      payload: { decision, policyVersion: this.policy.version, reasons },
    });

    if (decision === "deny") {
      await this.ledger.append({
        actionId: action.actionId,
        agentId: action.agentId,
        event: "blocked",
        payload: { reasons: reasons.filter((r) => r.severity === "block") },
      });
      return verdict;
    }

    if (decision === "require_approval") {
      this.pending.set(action.actionId, {
        action,
        verdict,
        requestedAt: new Date().toISOString(),
      });
      await this.ledger.append({
        actionId: action.actionId,
        agentId: action.agentId,
        event: "approval_requested",
        payload: { riskScore: screening.riskScore },
      });
      return verdict;
    }

    await this.run(action);
    return verdict;
  }

  async resolve(actionId: string, approve: boolean, by = "operator"): Promise<boolean> {
    const req = this.pending.get(actionId);
    if (!req) return false;

    this.pending.delete(actionId);

    await this.ledger.append({
      actionId,
      agentId: req.action.agentId,
      event: approve ? "approval_granted" : "approval_denied",
      payload: { by },
    });

    if (approve) await this.run(req.action);
    return true;
  }

  private async run(action: AgentAction): Promise<void> {
    const outcome = await this.executor(action);
    await this.ledger.append({
      actionId: action.actionId,
      agentId: action.agentId,
      event: "executed",
      payload: {
        kind: action.kind,
        amountMinor: action.amountMinor,
        currency: action.currency,
        target: safe(action.target),
        outcome: safe(outcome),
      },
    });
  }
}
