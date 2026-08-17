import type { ToolCall, ToolName, ToolSpec } from '../tools.js';
import type { Model, ModelMessage, ModelTurn } from './types.js';

/**
 * Live-model adapter (Anthropic Messages API).
 *
 * Used when PROOFPLANE_MODEL_PROVIDER=anthropic and ANTHROPIC_API_KEY is set. Everything
 * downstream — probes, evidence, OSCAL — is identical; only the thing being probed changes.
 *
 * Read results from this path differently: a real model is non-deterministic, so a single
 * "the injection did not work" run is not evidence the control holds. The probe runner reports
 * a breach RATE over n trials for exactly this reason, and the evidence record carries n.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

interface AnthropicToolUse {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicText {
  type: 'text';
  text: string;
}

type AnthropicBlock = AnthropicToolUse | AnthropicText | { type: string };

export class AnthropicModel implements Model {
  readonly provider = 'anthropic';

  constructor(
    readonly id: string,
    private readonly apiKey: string,
    private readonly maxTokens = 1024,
  ) {}

  async turn(messages: readonly ModelMessage[], tools: readonly ToolSpec[]): Promise<ModelTurn> {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    // Tool results are folded into the user turn as delimited text rather than as native
    // tool_result blocks. That keeps this adapter independent of how the agent loop assigns
    // tool-use ids, at the cost of not exercising Anthropic's own tool-result plumbing.
    const conversation = messages
      .filter((m) => m.role !== 'system')
      .map((m) => (m.role === 'tool' ? `[tool output]\n${m.content}` : m.content))
      .join('\n\n');

    const body = {
      model: this.id,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user' as const, content: conversation }],
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: 'object' as const,
          properties: Object.fromEntries(t.parameters.map((p) => [p, { type: 'string' }])),
          required: [...t.parameters],
        },
      })),
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { content?: AnthropicBlock[] };
    const blocks = json.content ?? [];

    const toolCalls: ToolCall[] = blocks
      .filter((b): b is AnthropicToolUse => b.type === 'tool_use')
      .map((b) => ({
        tool: b.name as ToolName,
        args: Object.fromEntries(
          Object.entries(b.input ?? {}).map(([k, v]) => [k, String(v)]),
        ),
        // A live model does not tell us which span of context motivated a call. Provenance is
        // therefore unknown here, and PP-P002 falls back to comparing against a control run
        // with no injected ticket present.
        provenance: 'user',
      }));

    const text = blocks
      .filter((b): b is AnthropicText => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return { toolCalls, text };
  }
}
