import type { LedgerEntry, LedgerEvent } from "./types.js";

const GENESIS = "0".repeat(64);
const STORAGE_KEY = "agentguard.ledger.v1";
/** The latest entry's seq and hash, stored separately so truncation shows up. */
const HEAD_KEY = "agentguard.ledger.head.v1";

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface VerifyResult {
  ok: boolean;
  brokenAtSeq: number | null;
  length: number;
  /** False when the last write to storage failed: memory and disk may differ. */
  persisted: boolean;
}

/**
 * Append-only, hash-chained audit ledger, running entirely in the browser.
 *
 * Each entry carries the hash of the one before it, so editing or removing a
 * record in the middle breaks every hash after it and `verify()` reports where.
 * The head (latest seq and hash) is stored apart from the entries, so cutting
 * entries off the end is caught too.
 *
 * What this does NOT do, stated plainly: the hashes are unkeyed and everything
 * lives in one origin's localStorage. Someone with access to that storage can
 * rewrite the whole chain, head included, and recompute every hash, and
 * `verify()` would pass. This detects casual and partial tampering. Defending
 * against a determined local attacker needs the head anchored somewhere they
 * cannot write: a server, a signed timestamp, a transparency log.
 *
 * Hashing is async because Web Crypto is, which is why `append` returns a
 * promise. Writes are serialised through a tail promise so two concurrent
 * appends cannot both read the same previous entry and fork the chain.
 */
export class Ledger {
  private entries: LedgerEntry[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private persistOk = true;

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
      const last = this.entries.at(-1);
      if (last) localStorage.setItem(HEAD_KEY, JSON.stringify({ seq: last.seq, hash: last.hash }));
      else localStorage.removeItem(HEAD_KEY);
      this.persistOk = true;
    } catch {
      // Over quota or blocked. The session carries on, but verify() reports it,
      // because from here on memory and storage can disagree.
      this.persistOk = false;
    }
  }

  private static readHead(): { seq: number; hash: string } | null {
    try {
      const raw = localStorage.getItem(HEAD_KEY);
      return raw ? (JSON.parse(raw) as { seq: number; hash: string }) : null;
    } catch {
      return null;
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

  /** How many actions the guard stopped — the number that justifies the tool. */
  stoppedCount(): number {
    return this.entries.filter(
      (e) => e.event === "blocked" || e.event === "approval_denied",
    ).length;
  }

  async verify(): Promise<VerifyResult> {
    const result = (ok: boolean, brokenAtSeq: number | null): VerifyResult => ({
      ok,
      brokenAtSeq,
      length: this.entries.length,
      persisted: this.persistOk,
    });

    let prevHash = GENESIS;
    for (const e of this.entries) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prevHash || (await sha256(Ledger.canonical(rest))) !== hash) {
        return result(false, e.seq);
      }
      prevHash = hash;
    }

    // The chain is internally consistent. Is it also the whole chain? An empty
    // or shortened ledger passes the loop above, so compare with the stored head.
    const head = Ledger.readHead();
    const last = this.entries.at(-1);
    if (head && (last?.seq !== head.seq || last?.hash !== head.hash)) {
      return result(false, head.seq);
    }

    return result(true, null);
  }

  /** Demo reset. Wipes the log AND its head, so a cleared ledger verifies as empty. */
  clear(): void {
    this.entries = [];
    this.persist();
  }
}
