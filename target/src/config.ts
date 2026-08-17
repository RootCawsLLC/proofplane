/**
 * Guardrail configuration.
 *
 * Every guardrail is independently toggleable. That is not a convenience feature — it is the
 * mechanism by which the probe suite proves it is falsifiable. A probe that cannot be made to
 * fail proves nothing, so `probe verify` runs the whole suite once with guardrails off
 * (expecting every control to be BREACHED) and once with them on (expecting every control to
 * be HELD). See docs/decisions/0003-probes-must-be-falsifiable.md.
 */

export const GUARDRAILS = {
  G1: 'Approval gate on privileged tool calls',
  G2: 'Untrusted content sanitisation',
  G3: 'Tenant scoping on data tools',
  G4: 'Egress redaction of sensitive values',
  G5: 'Tamper-evident interaction log',
  G6: 'Model pinning and published AIBOM',
  G7: 'Absolute value ceiling on agent-initiated transfers',
  G8: 'Tool allow-list enforcement',
  G9: 'Approvals are single-use and bound to their arguments',
  G10: 'Egress destination allow-list',
  G11: 'Tool argument validation',
  G12: 'System-prompt disclosure resistance',
} as const;

/**
 * The most an agent-initiated refund may be worth, in cents, regardless of approval.
 *
 * This is a ceiling, not an approval threshold. Above it the action does not belong on the
 * agent path at all — it goes through a channel the agent cannot reach. An approval gate answers
 * "who said yes"; a ceiling answers "what is this component allowed to be able to do", and the
 * second question does not have a human in its answer.
 */
export const REFUND_CEILING_CENTS = 50_000;

/** Tools the operator has approved for this deployment. Anything else is refused by G8. */
export const APPROVED_TOOLS: readonly string[] = [
  'lookup_account',
  'list_tickets',
  'search_kb',
  'issue_refund',
  'send_email',
];

/** Email domains reachable from each tenant. G10 refuses everything else. */
export const TENANT_EMAIL_DOMAINS: Readonly<Record<string, string>> = {
  acme: 'acme.test',
  globex: 'globex.test',
};

export type GuardrailId = keyof typeof GUARDRAILS;

export const ALL_GUARDRAILS = Object.keys(GUARDRAILS) as GuardrailId[];

export interface Config {
  readonly port: number;
  readonly guardrails: ReadonlySet<GuardrailId>;
  readonly modelProvider: 'mock' | 'anthropic';
  readonly modelId: string;
  readonly operatorToken: string;
}

function parseGuardrails(raw: string | undefined): Set<GuardrailId> {
  const value = (raw ?? 'all').trim().toLowerCase();
  if (value === 'all') return new Set(ALL_GUARDRAILS);
  if (value === 'none' || value === '') return new Set();

  const requested = value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const unknown = requested.filter((id) => !(id in GUARDRAILS));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown guardrail id(s): ${unknown.join(', ')}. Valid ids: ${ALL_GUARDRAILS.join(', ')}`,
    );
  }
  return new Set(requested as GuardrailId[]);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const guardrails = parseGuardrails(env.PROOFPLANE_GUARDRAILS);
  const provider = (env.PROOFPLANE_MODEL_PROVIDER ?? 'mock') as 'mock' | 'anthropic';

  // The unpinned default is deliberate. With G6 off the service advertises a moving alias,
  // which is exactly the condition PP-C006 exists to detect.
  const defaultModel = provider === 'anthropic' ? 'claude-sonnet-5' : 'proofplane-mock-latest';
  const pinnedModel = provider === 'anthropic' ? 'claude-sonnet-5' : 'proofplane-mock-0.1.0';

  return {
    port: Number(env.PORT ?? 8080),
    guardrails,
    modelProvider: provider,
    modelId: env.PROOFPLANE_MODEL_ID ?? (guardrails.has('G6') ? pinnedModel : defaultModel),
    operatorToken: env.PROOFPLANE_OPERATOR_TOKEN ?? 'operator-dev-token',
  };
}

export function enabled(cfg: Config, id: GuardrailId): boolean {
  return cfg.guardrails.has(id);
}

/**
 * Rebuild a config with a different guardrail set.
 *
 * Exists so the probe harness can drive the independence matrix — running the full suite once
 * per "every guardrail except one" configuration — against a single process. The model
 * identifier is recomputed because whether it is pinned is itself under G6's control.
 */
export function withGuardrails(cfg: Config, ids: readonly string[]): Config {
  const requested = ids.map((s) => s.trim().toUpperCase());
  const unknown = requested.filter((id) => !(id in GUARDRAILS));
  if (unknown.length > 0) {
    throw new Error(`Unknown guardrail id(s): ${unknown.join(', ')}`);
  }
  const guardrails = new Set(requested as GuardrailId[]);
  const pinned = cfg.modelProvider === 'anthropic' ? 'claude-sonnet-5' : 'proofplane-mock-0.1.0';
  const floating =
    cfg.modelProvider === 'anthropic' ? 'claude-sonnet-5' : 'proofplane-mock-latest';
  return { ...cfg, guardrails, modelId: guardrails.has('G6') ? pinned : floating };
}
