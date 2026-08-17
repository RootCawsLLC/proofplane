import type { ToolCall, ToolSpec } from '../tools.js';

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'tool';
  readonly content: string;
  /** Diagnostic provenance. No model uses this — that is the entire problem. */
  readonly provenance: 'system' | 'user' | 'untrusted_content';
}

export interface ModelTurn {
  readonly toolCalls: readonly ToolCall[];
  readonly text: string;
}

export interface Model {
  /** The identifier this runtime is actually serving. Compared against the AIBOM by PP-P006. */
  readonly id: string;
  readonly provider: string;
  turn(messages: readonly ModelMessage[], tools: readonly ToolSpec[]): Promise<ModelTurn>;
}

/** A model identifier is "pinned" when it does not resolve differently over time. */
export function isPinned(modelId: string): boolean {
  return !/(?:^|[-@:])(latest|stable|current|preview|dev)$/i.test(modelId);
}
