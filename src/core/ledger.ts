import type { LedgerEntry, LedgerEvent } from "./types.js";

const GENESIS = "0".repeat(64);
const STORAGE_KEY = "agentguard.ledger.v1";

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Append-only, hash-chained audit ledger, running entirely in the browser.
 *
 * Each entry carries the hash of the one before it, so editing or removing any
 * past record breaks every hash after it and `verify()` reports where. The
 * audit trail is the product here: the operator does not have to trust the
 * agent, or trust that nobody edited the log afterwards — they can check.
 *
 * Hashing is async because Web Crypto is, which is why `append` returns a
 * promise. Writes are serialised through a tail promise so two concurrent
 * appends cannot both read the same previous entry and fork the chain.
 */
export class Ledger {
  private entries: LedgerEntry[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.entries = raw ? (JSON.parse(raw) as LedgerEntry[]) : [];
    } catch {
      // Storage can be unavailable (private windows, blocked site data). An
      // in-memory ledger is degraded but still correct for this session.
      this.entries = [];
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      // Over quota or blocked. Keep going rather than losing the session.
    }
  }

  private static canonical(e: Omit<LedgerEntry, "hash">): string {
    // Fixed, explicit field order. Hashing a serialised object with unstable
    // key order would make verification flaky.
    return JSON.stringify([
      e.seq,
      e.actionId,
      e.agentId,
      e.event,
      e.payload,
      e.at,
      e.prevHash,
    ]);
  }

  append(input: {
    actionId: string;
    agentId: string;
    event: LedgerEvent;
    payload: Record<string, unknown>;
  }): Promise<LedgerEntry> {
    const next = this.tail.then(async () => {
      const prev = this.entries.at(-1);
      const base = {
        seq: (prev?.seq ?? 0) + 1,
        actionId: input.actionId,
        agentId: input.agentId,
        event: input.event,
        payload: input.payload,
        at: new Date().toISOString(),
        prevHash: prev?.hash ?? GENESIS,
      };
      const entry: LedgerEntry = { ...base, hash: await sha256(Ledger.canonical(base)) };
      this.entries.push(entry);
      this.persist();
      return entry;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** Total executed payment value in the trailing window. */
  spentSince(hours: number): number {
    const cutoff = Date.now() - hours * 3600_000;
    return this.entries
      .filter((e) => e.event === "executed" && new Date(e.at).getTime() >= cutoff)
      .reduce((sum, e) => sum + Number(e.payload.amountMinor ?? 0), 0);
  }

  /** How many actions the guard stopped — the number that justifies the tool. */
  stoppedCount(): number {
    return this.entries.filter(
      (e) => e.event === "blocked" || e.event === "approval_denied",
    ).length;
  }

  async verify(): Promise<{ ok: boolean; brokenAtSeq: number | null; length: number }> {
    let prevHash = GENESIS;
    for (const e of this.entries) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prevHash || (await sha256(Ledger.canonical(rest))) !== hash) {
        return { ok: false, brokenAtSeq: e.seq, length: this.entries.length };
      }
      prevHash = hash;
    }
    return { ok: true, brokenAtSeq: null, length: this.entries.length };
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }
}
