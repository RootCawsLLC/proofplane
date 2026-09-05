import type { Effect } from '../core/boundary.js';
import { ProposalQueue } from '../core/proposals.js';
import { Repo } from '../core/repo.js';

/**
 * The MCP surface.
 *
 * Note what is not here. There is no tool that sets a control's status, writes evidence, emits
 * OSCAL, or approves a proposal. That is not an oversight and it is not a roadmap item — those
 * operations are guarded by `assertHumanAuthority` and would throw if a tool reached them, and
 * a test asserts exactly that.
 *
 * Every tool declares an `effect`, and the type admits only two values. Adding a third would be
 * a deliberate act visible in a diff, which is the point.
 */

export interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly effect: Effect;
  readonly inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler(args: Record<string, unknown>, ctx: Context): Promise<unknown>;
}

export interface Context {
  readonly repo: Repo;
  readonly queue: ProposalQueue;
  readonly model: string;
}

const noArgs = { type: 'object' as const, properties: {} };

function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key];
  return typeof v === 'string' ? v : fallback;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (!v) throw new Error(`${key} is required`);
  return v;
}

export const TOOLS: ToolDef[] = [
  // ---- read -------------------------------------------------------------------------------
  {
    name: 'assurance_status',
    title: 'Current assurance status',
    description:
      'Which controls held and which breached in the latest run, with the trial count and — ' +
      'when a live model was serving — the 95% confidence interval on the true breach rate. ' +
      'Read the interval: zero breaches in three trials is consistent with a true rate above 50%.',
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        configuration: {
          type: 'string',
          enum: ['guarded', 'unguarded'],
          description: 'Defaults to guarded, the configuration the system claims to run.',
        },
      },
    },
    async handler(args, { repo }) {
      const configuration = (str(args, 'configuration', 'guarded') === 'unguarded'
        ? 'unguarded'
        : 'guarded') as 'guarded' | 'unguarded';
      const bundle = repo.evidence(configuration);
      return {
        run_id: bundle.run_id,
        recorded_at: bundle.recorded_at,
        guardrails_in_force: bundle.target.guardrails,
        serving_model: bundle.target.model,
        head_hash: bundle.head_hash,
        summary: bundle.summary,
        controls: bundle.records.map((r) => ({
          control_id: r.control_id,
          title: r.control_title,
          outcome: r.outcome,
          attack: r.attack,
          trials: r.trials,
          scope_note:
            r.trials.ci_meaningful === false
              ? 'Deterministic model double: this is evidence about the guardrail, not about any model.'
              : undefined,
        })),
      };
    },
  },
  {
    name: 'list_controls',
    title: 'List controls',
    description:
      'Every control with its guardrail, the probe that proves it, and its framework crosswalk. ' +
      'Each mapping carries a confidence and a written basis stating what was not verified.',
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        framework: {
          type: 'string',
          description: 'Filter to controls mapping to this framework, e.g. "EU AI Act".',
        },
      },
    },
    async handler(args, { repo }) {
      const filter = str(args, 'framework').toLowerCase();
      return repo
        .controls()
        .filter(
          (c) =>
            !filter || c.crosswalk.some((m) => m.framework.toLowerCase().includes(filter)),
        )
        .map((c) => ({
          id: c.id,
          title: c.title,
          guardrail: c.guardrail,
          proved_by: c.proved_by,
          threats: [...c.threat.atlas, ...c.threat.owasp_asi].map((t) => t.id),
          crosswalk: c.crosswalk.map((m) => ({
            framework: m.framework,
            reference: m.reference,
            confidence: m.confidence,
          })),
        }));
    },
  },
  {
    name: 'get_control',
    title: 'Get one control in full',
    description:
      'The full statement, rationale, stated limits, assertion, threat mapping and crosswalk ' +
      'with every basis. Use this before proposing anything about a control.',
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: { control_id: { type: 'string', description: 'e.g. PP-C001' } },
      required: ['control_id'],
    },
    async handler(args, { repo }) {
      const id = requireStr(args, 'control_id');
      const control = repo.controls().find((c) => c.id === id);
      if (!control) throw new Error(`no control ${id}`);
      return control;
    },
  },
  {
    name: 'verify_evidence_chain',
    title: 'Verify the evidence chain',
    description:
      'Recomputes every evidence hash from genesis rather than trusting the head hash the file ' +
      'reports about itself. Returns where the chain breaks, if it does.',
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        configuration: { type: 'string', enum: ['guarded', 'unguarded'] },
      },
    },
    async handler(args, { repo }) {
      const configuration = (str(args, 'configuration', 'guarded') === 'unguarded'
        ? 'unguarded'
        : 'guarded') as 'guarded' | 'unguarded';
      return repo.verifyChain(configuration);
    },
  },
  {
    name: 'independence_matrix',
    title: 'Probe independence matrix',
    description:
      'One guardrail disabled per row, the whole suite run against each configuration. The ' +
      'diagonal must breach and everything off it must hold; otherwise a probe is reacting to ' +
      'a control other than the one it names.',
    effect: 'read',
    inputSchema: noArgs,
    async handler(_args, { repo }) {
      return repo.matrix();
    },
  },
  {
    name: 'coverage_by_framework',
    title: 'Framework coverage',
    description:
      'How many controls map to each framework, at what confidence, and whether the citation ' +
      'resolved against the Secure Controls Framework crosswalk. Coverage means a control maps ' +
      'to a requirement — never that the requirement is satisfied.',
    effect: 'read',
    inputSchema: noArgs,
    async handler(_args, { repo }) {
      const byFramework = new Map<
        string,
        { mappings: number; high: number; medium: number; low: number; controls: Set<string> }
      >();

      for (const control of repo.controls()) {
        for (const m of control.crosswalk) {
          const entry = byFramework.get(m.framework) ?? {
            mappings: 0,
            high: 0,
            medium: 0,
            low: 0,
            controls: new Set<string>(),
          };
          entry.mappings += 1;
          entry[m.confidence] += 1;
          entry.controls.add(control.id);
          byFramework.set(m.framework, entry);
        }
      }

      let corroborated = 0;
      let uncorroborated = 0;
      try {
        for (const f of repo.corroboration()) {
          if (f.status === 'resolved') corroborated += 1;
          else if (f.status === 'unresolved') uncorroborated += 1;
        }
      } catch {
        // Corroboration is optional; absence is reported, not invented.
      }

      return {
        note:
          'Coverage means a control maps to a requirement. It does not mean the requirement is ' +
          'satisfied. A citation resolving against SCF establishes the clause number is real, ' +
          'not that this control belongs under it.',
        citations_resolved: corroborated,
        citations_unresolved: uncorroborated,
        frameworks: [...byFramework.entries()]
          .map(([framework, v]) => ({
            framework,
            controls: v.controls.size,
            mappings: v.mappings,
            confidence: { high: v.high, medium: v.medium, low: v.low },
          }))
          .sort((a, b) => b.mappings - a.mappings),
      };
    },
  },
  {
    name: 'ai_inventory',
    title: 'AI bill of materials',
    description:
      'The AI surface discovered by static scan: models, SDKs, MCP servers and cloud AI ' +
      'resources, each with the file and line that produced it, and whether it is on the ' +
      'sanctioned list.',
    effect: 'read',
    inputSchema: noArgs,
    async handler(_args, { repo }) {
      const bom = repo.aibom();
      const prop = (props: { name: string; value: string }[], name: string) =>
        props.find((p) => p.name === name)?.value;
      return {
        spec_version: bom.specVersion,
        run: Object.fromEntries(bom.metadata.properties.map((p) => [p.name, p.value])),
        components: bom.components.map((c) => ({
          name: c.name,
          type: c.type,
          declared: prop(c.properties, 'proofplane:declared') === 'true',
          occurrences: prop(c.properties, 'proofplane:occurrences'),
          first_seen: prop(c.properties, 'proofplane:evidence'),
        })),
      };
    },
  },
  {
    name: 'documented_limitations',
    title: 'Executed limitation demonstrations',
    description:
      'The weaknesses the documentation admits to, executed against a fully guarded target. ' +
      'CONFIRMED means the bypass worked and the control behind it held; ESCALATED means both ' +
      'failed, which is a finding against the architecture.',
    effect: 'read',
    inputSchema: noArgs,
    async handler(_args, { repo }) {
      return repo.limits();
    },
  },
  {
    name: 'list_proposals',
    title: 'List proposals',
    description:
      'Everything waiting on a human decision, plus what has already been decided and by whom. ' +
      'Approving is not available through this interface by design.',
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'all'] },
      },
    },
    async handler(args, { queue }) {
      const wanted = str(args, 'status', 'pending');
      const items = wanted === 'all' ? queue.all() : queue.all().filter((p) => p.status === wanted);
      return {
        chain: queue.verify(),
        proposals: items,
        note: 'To act on one: proofplane-operator approve <id> --operator "<name>" --note "<why>"',
      };
    },
  },

  // ---- propose ----------------------------------------------------------------------------
  {
    name: 'propose_remediation',
    title: 'Propose a remediation for a breached control',
    description:
      'Records a judgment about how a breached control should be fixed. This queues it for a ' +
      'human. It does not change any control status, and nothing here reaches the evidence.',
    effect: 'propose',
    inputSchema: {
      type: 'object',
      properties: {
        control_id: { type: 'string' },
        title: { type: 'string', description: 'One line summarizing the fix.' },
        rationale: {
          type: 'string',
          description: 'Why this fix, and what it does not address. Reviewers read this.',
        },
        change: {
          type: 'string',
          description: 'The concrete change proposed, e.g. which guardrail and what it should do.',
        },
      },
      required: ['control_id', 'title', 'rationale', 'change'],
    },
    async handler(args, { repo, queue, model }) {
      const controlId = requireStr(args, 'control_id');
      if (!repo.controls().some((c) => c.id === controlId)) {
        throw new Error(`no control ${controlId} — propose against a control that exists`);
      }
      return queue.propose({
        kind: 'remediation',
        title: requireStr(args, 'title'),
        rationale: requireStr(args, 'rationale'),
        controlId,
        payload: { change: requireStr(args, 'change') },
        model,
      });
    },
  },
  {
    name: 'propose_control_mapping',
    title: 'Propose a framework mapping',
    description:
      'Records a judgment that a control bears on a framework requirement. Must state a ' +
      'confidence and a basis saying what was not verified — a mapping without one is an ' +
      'assertion, and the catalog loader rejects those.',
    effect: 'propose',
    inputSchema: {
      type: 'object',
      properties: {
        control_id: { type: 'string' },
        framework: { type: 'string' },
        reference: { type: 'string', description: 'The citation in that framework’s numbering.' },
        reference_kind: {
          type: 'string',
          enum: [
            'article',
            'annex_a_group',
            'annex_a_control',
            'subcategory',
            'domain',
            'principle_name',
            'theme',
          ],
        },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        basis: {
          type: 'string',
          description: 'Why this mapping, and explicitly what was not verified.',
        },
      },
      required: ['control_id', 'framework', 'reference', 'reference_kind', 'confidence', 'basis'],
    },
    async handler(args, { repo, queue, model }) {
      const controlId = requireStr(args, 'control_id');
      if (!repo.controls().some((c) => c.id === controlId)) {
        throw new Error(`no control ${controlId}`);
      }
      const basis = requireStr(args, 'basis');
      if (basis.length < 20) {
        throw new Error(
          'basis is too short to be a basis — state what was and was not verified',
        );
      }
      return queue.propose({
        kind: 'control-mapping',
        title: `${str(args, 'framework')} ${str(args, 'reference')} → ${controlId}`,
        rationale: basis,
        controlId,
        payload: {
          framework: requireStr(args, 'framework'),
          reference: requireStr(args, 'reference'),
          reference_kind: requireStr(args, 'reference_kind'),
          confidence: requireStr(args, 'confidence'),
          basis,
        },
        model,
      });
    },
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
