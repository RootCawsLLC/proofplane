import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The determinism boundary.
 *
 * The brief this was built against asks for "agentic AI and deterministic automation". The
 * interesting word is *and*: some of this work wants a model's judgment, and some of it must
 * never be within reach of one.
 *
 * The split used here:
 *
 *   Judgment — which existing control a newly published requirement bears on, how to word a
 *   Statement of Applicability entry, what a breached control's remediation should be, how to
 *   explain drift to a stakeholder. All of it revisable, all of it reviewed before it counts.
 *
 *   Authority — whether a control is satisfied, what the evidence hash is, what goes into the
 *   OSCAL, whether a proposal takes effect. None of it revisable after the fact without leaving
 *   a trace, and none of it improved by being persuadable.
 *
 * Stating that split in a comment is worth nothing, so it is enforced. Every MCP tool invocation
 * runs inside `underModelAuthority`. Every operation carrying a compliance consequence calls
 * `assertHumanAuthority` first, which throws if it finds itself inside that context — including
 * transitively, through any depth of call stack, because AsyncLocalStorage propagates.
 *
 * The result is that "the model cannot decide this" is a property the test suite can check
 * rather than a convention a future contributor has to remember. See
 * docs/decisions/0006-the-determinism-boundary-is-enforced.md.
 */

interface ModelContext {
  readonly tool: string;
  readonly invocationId: string;
}

const modelAuthority = new AsyncLocalStorage<ModelContext>();

export class DeterminismBoundaryError extends Error {
  constructor(
    readonly operation: string,
    readonly tool: string,
  ) {
    super(
      `Refused: "${operation}" carries a compliance consequence and was reached from the ` +
        `model-facing tool "${tool}". A model may propose this; it may not decide it. ` +
        `See docs/decisions/0006-the-determinism-boundary-is-enforced.md.`,
    );
    this.name = 'DeterminismBoundaryError';
  }
}

/** Wraps every MCP tool invocation. Anything reached from here is under model authority. */
export function underModelAuthority<T>(
  tool: string,
  invocationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return modelAuthority.run({ tool, invocationId }, fn);
}

/**
 * Guard for any operation whose result is a compliance claim.
 *
 * Call it first, before any work — a partial effect followed by a throw is worse than a refusal.
 */
export function assertHumanAuthority(operation: string): void {
  const context = modelAuthority.getStore();
  if (context) {
    throw new DeterminismBoundaryError(operation, context.tool);
  }
}

export function currentModelContext(): ModelContext | undefined {
  return modelAuthority.getStore();
}

/** What a tool is permitted to do. There is deliberately no third value. */
export type Effect = 'read' | 'propose';

export const EFFECTS: readonly Effect[] = ['read', 'propose'];
