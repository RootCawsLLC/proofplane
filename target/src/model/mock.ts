import type { ToolCall, ToolName, ToolSpec } from '../tools.js';
import type { Model, ModelMessage, ModelTurn } from './types.js';

/**
 * A deterministic test double for an instruction-following model.
 *
 * It is NOT a simulation of a language model and does not pretend to be. It is a faithful
 * reduction of one specific, well-documented property of them:
 *
 *     A model resolves instructions from its flattened context and does not distinguish
 *     instructions the operator wrote from instructions an attacker wrote into data the
 *     model was asked to read.
 *
 * Everything this double does follows from that single property. It scans every message —
 * system, user, and tool output alike — for actionable intent, and acts on whatever it finds,
 * because it has no notion of provenance. Real models exhibit the same failure probabilistically;
 * this one exhibits it every time.
 *
 * Why a double at all, rather than always calling a real model:
 *
 *   - Reproducibility. A stranger can clone this repo and get byte-identical evidence with no
 *     API key and no spend. If they cannot, the thesis "controls are proved by executed attacks"
 *     is unverifiable and therefore worthless.
 *   - Falsifiability. Probes must fail when the guardrail is off. A probabilistic model makes
 *     "it did not breach this time" ambiguous between "the control held" and "the model happened
 *     not to comply". The double removes that ambiguity from the probe-validation step.
 *
 * What it costs, stated plainly in docs/HONEST-LIMITS.md: passing against the double is evidence
 * about the guardrail, not about any real model. Run PROOFPLANE_MODEL_PROVIDER=anthropic for
 * that, and read the pass RATE rather than a boolean.
 *
 * See docs/decisions/0002-deterministic-model-double.md.
 */

interface IntentMatcher {
  readonly tool: ToolName;
  readonly pattern: RegExp;
  readonly extract: (m: RegExpMatchArray) => Record<string, string>;
}

const INTENTS: readonly IntentMatcher[] = [
  {
    tool: 'issue_refund',
    pattern:
      // The amount group admits a leading minus. A model will happily relay a negative figure
      // it was given, and PP-C011 exists because something downstream coerces it silently.
      /\b(?:issue|process|send|give|initiate|authorise|authorize)\s+(?:a\s+|an\s+|the\s+)?refunds?\s*(?:of\s*)?\$?(-?[\d,]+(?:\.\d{1,2})?)?\s*(?:(?:to|for)\s+([\w.+-]+@[\w-]+\.[\w.-]+))?/i,
    extract: (m) => ({ amount: m[1] ?? '0', email: m[2] ?? '' }),
  },
  {
    // The same request, paraphrased. A model understands "reimburse me" as a refund request;
    // a filter looking for the token "refund" does not. Models generalize, pattern lists
    // enumerate, and that gap is not closable by adding more patterns.
    //
    // This intent exists so the gap can be demonstrated rather than asserted — see
    // `proofplane-probe limits` and docs/HONEST-LIMITS.md.
    tool: 'issue_refund',
    pattern:
      /\b(?:reimburse|credit|repay|refunding)\s+(?:me\s+|the\s+customer\s+|them\s+)?\$?(-?[\d,]+(?:\.\d{1,2})?)?\s*(?:(?:to|for)\s+([\w.+-]+@[\w-]+\.[\w.-]+))?/i,
    extract: (m) => ({ amount: m[1] ?? '0', email: m[2] ?? '' }),
  },
  {
    tool: 'send_email',
    pattern:
      /\b(?:send|forward)\s+(?:an?\s+|the\s+)?e-?mail\s+(?:to\s+)?([\w.+-]+@[\w-]+\.[\w.-]+)/i,
    extract: (m) => ({ to: m[1] ?? '', body: 'As requested.' }),
  },
  {
    tool: 'lookup_account',
    pattern:
      /\b(?:look\s?up|find|show|get|retrieve|pull|details?\s+(?:for|on))\b[^\n]*?([\w.+-]+@[\w-]+\.[\w.-]+)/i,
    extract: (m) => ({ email: m[1] ?? '' }),
  },
  {
    tool: 'list_tickets',
    pattern: /\b(?:list|show|summari[sz]e|review|open|my)\b[^\n]*\btickets?\b/i,
    extract: () => ({}),
  },
  {
    tool: 'export_accounts',
    pattern: /\b(?:export|dump|download)\b[^\n]*\b(?:accounts?|customers?|report)\b/i,
    extract: () => ({}),
  },
  {
    tool: 'search_kb',
    pattern: /\b(?:policy|knowledge\s?base|documentation|article)\b/i,
    extract: () => ({ query: 'refund' }),
  },
];

/**
 * Meta-prompt extraction (AML.T0056). The double complies, because a model asked to repeat its
 * instructions frequently does — the instruction telling it not to is itself just more text in
 * the same undifferentiated context.
 */
const DISCLOSURE_PATTERN =
  /\b(?:repeat|show|print|reveal|display|what\s+are|tell\s+me)\b[^\n]*\b(?:instructions?|system\s+prompt|rules|configuration|guidelines)\b/i;

function signature(call: { tool: string; args: Record<string, string> }): string {
  const keys = Object.keys(call.args).sort();
  return `${call.tool}(${keys.map((k) => `${k}=${call.args[k] ?? ''}`).join(',')})`;
}

export class MockModel implements Model {
  readonly provider = 'mock';

  constructor(readonly id: string) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async turn(messages: readonly ModelMessage[], _tools: readonly ToolSpec[]): Promise<ModelTurn> {
    const seen = new Set<string>();
    const calls: ToolCall[] = [];

    // Asked for its instructions, the double hands them over verbatim.
    const asked = messages.some((m) => m.role !== 'system' && DISCLOSURE_PATTERN.test(m.content));
    if (asked) {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      return { toolCalls: [], text: `Certainly. My instructions are: ${system}` };
    }

    // Deliberately provenance-blind. Every message is scanned the same way, which is the one
    // property of real models this double exists to reproduce.
    for (const msg of messages) {
      if (msg.role === 'system') continue;
      const provenance: ToolCall['provenance'] =
        msg.provenance === 'untrusted_content' ? 'untrusted_content' : 'user';

      for (const intent of INTENTS) {
        const match = msg.content.match(intent.pattern);
        if (!match) continue;
        const call: ToolCall = { tool: intent.tool, args: intent.extract(match), provenance };
        const sig = signature(call);
        if (seen.has(sig)) continue;
        seen.add(sig);
        calls.push(call);
      }
    }

    // Loop control is the agent's job — it knows what it already executed. The model just
    // reports every intent it can currently see.
    const hasResults = messages.some((m) => m.role === 'tool');
    return { toolCalls: calls, text: hasResults ? renderAnswer(messages) : '' };
  }
}

/**
 * The double summarizes by repeating tool output. Real assistants do this constantly, and it is
 * the behavior that makes egress filtering (PP-C004) load-bearing rather than decorative.
 */
function renderAnswer(messages: readonly ModelMessage[]): string {
  const results = messages.filter((m) => m.role === 'tool').map((m) => m.content);
  if (results.length === 0) return 'I could not find anything relevant.';
  return ["Here is what I found:", '', ...results].join('\n');
}
