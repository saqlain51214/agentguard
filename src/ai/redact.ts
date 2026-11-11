/**
 * Redaction, applied before anything leaves the device.
 *
 * This is the load-bearing piece of AgentGuard's privacy claim, so it is worth
 * being exact about what it is: pattern-based redaction. It reliably removes the
 * identifier *formats* listed below. It does NOT understand free text. A name
 * with no label next to it, a project codename or a sentence describing a
 * secret will survive. The cloud therefore sees a redacted version of the
 * action, never "nothing" — which is why escalation is rare, why anything that
 * contained credential material is never escalated at all (see
 * `hasCredentials`), and why the exact text that left the device is shown to
 * the operator.
 *
 * It is written to over-redact rather than under-redact: a harmless string
 * turning into a placeholder costs a little context, a leaked identifier costs
 * the whole premise.
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

/** Labels that mean the action carried credential material. */
const CREDENTIAL_LABELS = new Set([
  "private key block",
  "bearer token",
  "credential assignment",
  "api key",
  "aws key",
  "google api key",
  "gitlab token",
  "jwt",
]);

const PATTERNS: Pattern[] = [
  // Credentials first — these must never survive, even partially.
  { label: "private key block", re: /-----BEGIN[\s\S]*?-----END[^-]*-----/g, replace: "[PRIVATE_KEY]" },
  { label: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, replace: "[TOKEN]" },
  {
    label: "credential assignment",
    re: /\b(?:password|passwd|pwd|passphrase|secret(?:[_ -]?key)?|api[_ -]?key|access[_ -]?key|auth(?:orization)?[_ -]?token|token)\b\s*[:=]\s*\S+/gi,
    replace: "[CREDENTIAL]",
  },
  { label: "aws key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: "[API_KEY]" },
  { label: "google api key", re: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: "[API_KEY]" },
  { label: "gitlab token", re: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: "[API_KEY]" },
  { label: "api key", re: /\b(?:sk|pk|rk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, replace: "[API_KEY]" },
  { label: "api key", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "[API_KEY]" },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: "[JWT]" },

  // Direct identifiers. Unicode-aware: \b is ASCII-only, so it is not used here.
  {
    label: "email",
    re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu,
    replace: "[EMAIL]",
  },
  { label: "iban", re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g, replace: "[IBAN]" },
  { label: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: "[SSN]" },
  // IP before phone: a dotted quad also satisfies the phone pattern, and
  // whichever runs first wins the label. Redacted either way, but the UI shows
  // the operator what was removed, so the label needs to be right.
  { label: "ip address", re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, replace: "[IP]" },
  // Full-form IPv6 only (four or more groups). Compressed forms are not covered.
  { label: "ip address", re: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, replace: "[IP]" },
  // The inner group never consumes a trailing separator, so the space after a
  // card number survives into the redacted text.
  { label: "card number", re: /\b\d(?:[ -]?\d){12,18}\b/g, replace: "[CARD_OR_LONG_NUMBER]" },
  { label: "phone", re: /\+?\d(?:[\d\s().-]{7,}\d)/g, replace: "[PHONE]" },
  { label: "phone", re: /\b\d{3}[-. ]\d{4}\b/g, replace: "[PHONE]" },

  // Names are only caught when a label sits next to them. There is no reliable
  // way to find an unlabelled name with a regex, and this does not pretend to.
  {
    label: "name",
    re: /\b(Customer|Client|User|Mr|Mrs|Ms|Dr|Hi|Dear)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g,
    replace: (m) => `${m.split(/\s+/)[0]} [NAME]`,
  },
  {
    label: "street address",
    re: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd)\b/g,
    replace: "[ADDRESS]",
  },
  {
    label: "internal host",
    re: /\b(?:[a-z0-9-]+\.)+(?:internal|corp|local|lan|intranet)\b/gi,
    replace: "[HOST]",
  },

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

/**
 * Long opaque strings are probably secrets or ids even if no pattern matched.
 * Twenty characters when they contain a digit (ids, hex, base64), thirty-two
 * otherwise, so ordinary long words are left alone.
 */
const OPAQUE_WITH_DIGIT = /\b(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}\b/g;
const OPAQUE_ANY = /\b[A-Za-z0-9_-]{32,}\b/g;

function applyPatterns(text: string): RedactionResult {
  const removed: Record<string, number> = {};
  let out = text;

  for (const { label, re, replace } of PATTERNS) {
    out = out.replace(re, (m: string) => {
      removed[label] = (removed[label] ?? 0) + 1;
      return typeof replace === "function" ? replace(m) : replace;
    });
  }

  for (const re of [OPAQUE_WITH_DIGIT, OPAQUE_ANY]) {
    out = out.replace(re, (m) => {
      // Don't re-redact our own placeholders.
      if (m.startsWith("[") || /^[A-Z_]+$/.test(m)) return m;
      removed["opaque string"] = (removed["opaque string"] ?? 0) + 1;
      return "[OPAQUE]";
    });
  }

  return { text: out, removed };
}

export function redact(text: string): RedactionResult {
  const { text: out, removed } = applyPatterns(text);

  // Cap length. A long document adds little to a risk judgement and widens the
  // window for something identifying to slip through.
  const capped = out.length > 600 ? out.slice(0, 600) + " […truncated]" : out;
  return { text: capped, removed };
}

/** Did redaction have to remove credential material? If so, nothing is escalated. */
export function hasCredentials(removed: Record<string, number>): boolean {
  return Object.keys(removed).some((k) => CREDENTIAL_LABELS.has(k));
}

/**
 * Independent re-check of already-redacted text: running the redactor over it
 * again must change nothing. If it does, something identifying survived the
 * first pass and the text must not leave the device. This checks every pattern
 * `redact()` knows, not a hand-picked subset.
 */
export function looksClean(text: string): boolean {
  const body = text.replace(/ \[…truncated\]$/, "");
  return applyPatterns(body).text === body;
}
