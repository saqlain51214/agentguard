/**
 * Redaction, applied before anything leaves the device.
 *
 * This is the load-bearing piece of AgentGuard's privacy claim. On-device
 * screening sees the real payload; the cloud only ever sees what comes out of
 * here. If this were decorative, the whole "your data stays local" story would
 * be false, so it is written to be conservative: it would rather over-redact a
 * harmless string than let one identifier through.
 *
 * The output is still useful to a model — structure, intent and shape survive.
 * Identity does not.
 */

export interface RedactionResult {
  text: string;
  /** What was removed, by kind, for display in the UI. */
  removed: Record<string, number>;
}

interface Pattern {
  label: string;
  re: RegExp;
  replace: string | ((m: string) => string);
}

const PATTERNS: Pattern[] = [
  // Credentials first — these must never survive, even partially.
  { label: "private key block", re: /-----BEGIN[\s\S]*?-----END[^-]*-----/g, replace: "[PRIVATE_KEY]" },
  { label: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, replace: "[TOKEN]" },
  { label: "api key", re: /\b(?:sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, replace: "[API_KEY]" },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: "[JWT]" },

  // Direct identifiers.
  { label: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: "[EMAIL]" },
  // IP before phone: a dotted quad also satisfies the phone pattern, and
  // whichever runs first wins the label. Redacted either way, but the UI shows
  // the operator what was removed, so the label needs to be right.
  { label: "ip address", re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, replace: "[IP]" },
  // The inner group never consumes a trailing separator, so the space after a
  // card number survives into the redacted text.
  { label: "card number", re: /\b\d(?:[ -]?\d){12,18}\b/g, replace: "[CARD_OR_LONG_NUMBER]" },
  { label: "phone", re: /\+?\d(?:[\d\s().-]{7,}\d)/g, replace: "[PHONE]" },

  // URLs keep their host so the model can still reason about where something
  // is going, but lose the path and query, which is where identifiers hide.
  {
    label: "url path",
    re: /\bhttps?:\/\/([^\s/]+)(\/\S*)?/gi,
    replace: (m) => {
      try {
        return `https://${new URL(m).hostname}/[PATH]`;
      } catch {
        return "[URL]";
      }
    },
  },

  // Money becomes a bucket: magnitude is what matters for risk, not the exact
  // figure, and exact figures are linkable back to a transaction.
  {
    label: "amount",
    re: /(?:[$£€]\s?\d[\d,]*(?:\.\d{2})?)|(?:\b\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP)\b)/gi,
    replace: (m) => bucket(parseFloat(m.replace(/[^\d.]/g, ""))),
  },
];

function bucket(value: number): string {
  if (!Number.isFinite(value)) return "[AMOUNT]";
  if (value < 50) return "[AMOUNT<50]";
  if (value < 200) return "[AMOUNT_50_200]";
  if (value < 1000) return "[AMOUNT_200_1K]";
  if (value < 10000) return "[AMOUNT_1K_10K]";
  return "[AMOUNT>10K]";
}

/** Long opaque strings are probably secrets or ids even if no pattern matched. */
const OPAQUE = /\b[A-Za-z0-9_-]{32,}\b/g;

export function redact(text: string): RedactionResult {
  const removed: Record<string, number> = {};
  let out = text;

  for (const { label, re, replace } of PATTERNS) {
    out = out.replace(re, (m: string) => {
      removed[label] = (removed[label] ?? 0) + 1;
      return typeof replace === "function" ? replace(m) : replace;
    });
  }

  out = out.replace(OPAQUE, (m) => {
    // Don't re-redact our own placeholders.
    if (m.startsWith("[") || /^[A-Z_]+$/.test(m)) return m;
    removed["opaque string"] = (removed["opaque string"] ?? 0) + 1;
    return "[OPAQUE]";
  });

  // Cap length. A long document adds little to a risk judgement and widens the
  // window for something identifying to slip through.
  if (out.length > 600) out = out.slice(0, 600) + " […truncated]";

  return { text: out, removed };
}

/**
 * Sanity check used by the UI: does the redacted text still contain anything
 * that looks like a raw identifier? Shown next to the escalation so the claim
 * can be inspected rather than taken on faith.
 */
export function looksClean(text: string): boolean {
  return (
    !/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(text) &&
    !/\b(?:\d[ -]?){13,19}\b/.test(text) &&
    !/\b(?:sk|pk|ghp)[-_][A-Za-z0-9_-]{12,}/.test(text)
  );
}
