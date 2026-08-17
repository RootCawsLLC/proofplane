/**
 * Guardrail G4 — egress redaction (control PP-C004).
 *
 * Placed after the model, deliberately. A prompt instructing the model not to reveal an
 * identifier has an unknown failure rate. A filter on the response has a measurable one.
 *
 * Known limits, restated in docs/HONEST-LIMITS.md:
 *   - Pattern-based. It will not catch an identifier the model has reformatted (spelled out,
 *     base64'd, split across lines, translated).
 *   - It redacts by shape, so it will occasionally redact something that merely looks like an
 *     identifier. That trade is deliberate: over-redaction is a support ticket, under-redaction
 *     is a breach.
 */

export interface RedactionResult {
  readonly text: string;
  readonly redactions: { kind: string; count: number }[];
}

interface Rule {
  kind: string;
  pattern: RegExp;
  replacement: string;
}

const RULES: Rule[] = [
  {
    kind: 'national_id',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED:national_id]',
  },
  {
    // 13-19 digits, optionally separated, validated by Luhn below to cut false positives.
    kind: 'payment_card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    replacement: '[REDACTED:payment_card]',
  },
  {
    kind: 'email',
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    replacement: '[REDACTED:email]',
  },
];

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * @param allowEmails addresses belonging to the authenticated caller, which are not redacted.
 */
export function redact(text: string, allowEmails: readonly string[] = []): RedactionResult {
  const allow = new Set(allowEmails.map((e) => e.toLowerCase()));
  const counts = new Map<string, number>();
  let out = text;

  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match) => {
      if (rule.kind === 'email' && allow.has(match.toLowerCase())) return match;
      if (rule.kind === 'payment_card' && !luhnValid(match)) return match;
      counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
      return rule.replacement;
    });
  }

  return {
    text: out,
    redactions: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
  };
}
