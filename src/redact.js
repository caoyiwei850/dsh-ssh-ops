/** Keep credentials out of model-visible SSH tool results. */
const RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, "*** private key redacted ***"],
  [/(authorization\s*[:=]\s*bearer\s+)\S+/gi, "$1***"],
  [/\b(AWS_SECRET_ACCESS_KEY|API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|PASSWD)\s*[=:]\s*[^\s'"]+/gi, "$1=***"],
  [/(mysql|postgres(?:ql)?|redis):\/\/[^\s:@/]+:[^@\s/]+@/gi, "$1://***@"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-***"]
];

export function redactForModel(text) {
  let value = String(text ?? "");
  let redacted = false;
  for (const [pattern, replacement] of RULES) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) redacted = true;
    pattern.lastIndex = 0;
    value = value.replace(pattern, replacement);
  }
  return { text: value, redacted };
}
