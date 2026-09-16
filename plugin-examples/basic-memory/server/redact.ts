interface RedactionRule {
  pattern: RegExp;
  marker: string;
}

// Credential shapes first: an email or digit rule must never re-process a
// token the earlier rules already masked.
const RULES: RedactionRule[] = [
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, marker: "[token]" },
  {
    pattern: /\b(?:sk|ghp|gho|ghu|ghs|github_pat|xox[bpors])[-_][A-Za-z0-9]{16,}/g,
    marker: "[token]",
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, marker: "[token]" },
  {
    pattern: /(?<=\b(?:token|secret|key|password|passwd|pwd)["'\s:=]{1,4})[A-Za-z0-9+/_=-]{32,}/gi,
    marker: "[token]",
  },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, marker: "[email]" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, marker: "[ssn]" },
  { pattern: /\b\d{2}-\d{7}\b/g, marker: "[ein]" },
  { pattern: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, marker: "[phone]" },
  { pattern: /\b\d{9,19}\b/g, marker: "[number]" },
];

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.marker);
  }
  return out;
}
