#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { ProposalQueue } from './core/proposals.js';
import { Repo } from './core/repo.js';

/**
 * The human side of the operator.
 *
 * `approve` and `reject` live here rather than on the MCP surface, and that placement is the
 * control. Nothing in this file ever runs inside a model context, so `assertHumanAuthority`
 * passes; if a tool were ever wired to reach these, it would throw instead.
 *
 * `triage` is the autonomous path — it asks a model to draft remediations for breached controls
 * and writes them to the same queue as everything else. Autonomy changes who writes the
 * proposal. It does not change who decides.
 */

const TRIAGE_SYSTEM = [
  'You are drafting remediation proposals for a security control that failed an executed',
  'adversarial test. You are not deciding anything: every proposal you produce is queued for a',
  'human to approve or reject.',
  '',
  'For each control, propose the smallest change that would make the attack fail, and state',
  'plainly what your fix does NOT address. A proposal that overstates its coverage is worse',
  'than no proposal, because it will be approved on the strength of the overstatement.',
  '',
  'Prefer controls that do not depend on a model behaving well. If a fix relies on instructing',
  'a model not to do something, say so explicitly and name it as a mitigation rather than a',
  'control.',
].join('\n');

interface TriageDraft {
  control_id: string;
  title: string;
  rationale: string;
  change: string;
}

async function cmdTriage(repo: Repo, queue: ProposalQueue, args: Map<string, string>): Promise<number> {
  const configuration = (args.get('configuration') ?? 'unguarded') as 'guarded' | 'unguarded';
  const bundle = repo.evidence(configuration);
  const breached = bundle.records.filter((r) => r.outcome === 'BREACHED');

  if (breached.length === 0) {
    console.log(`no breached controls in the ${configuration} run — nothing to triage`);
    return 0;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(`${breached.length} breached control(s) in the ${configuration} run:`);
    for (const r of breached) console.log(`  ${r.control_id}  ${r.control_title}`);
    console.log('\nANTHROPIC_API_KEY is not set, so no drafts were produced.');
    console.log('Set it to have the operator draft remediations into the proposal queue.');
    return 0;
  }

  const model = process.env.PROOFPLANE_OPERATOR_MODEL ?? 'claude-sonnet-5';
  const client = new Anthropic({ apiKey });
  const controls = repo.controls();

  const brief = breached.map((r) => {
    const control = controls.find((c) => c.id === r.control_id);
    return {
      control_id: r.control_id,
      title: r.control_title,
      statement: control?.statement ?? '',
      guardrail: control?.guardrail ?? '',
      attack: r.attack,
      breaches: `${r.trials.breached}/${r.trials.n}`,
      observations: r.observations.slice(0, 6),
    };
  });

  console.log(`drafting remediations for ${breached.length} control(s) with ${model}…`);

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: TRIAGE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          'Here are the controls that breached, with what the probe observed:',
          '',
          JSON.stringify(brief, null, 2),
          '',
          'Reply with JSON only: an array of objects with keys control_id, title, rationale,',
          'change. No prose outside the JSON.',
        ].join('\n'),
      },
    ],
  });

  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');

  const match = /\[[\s\S]*\]/.exec(text);
  if (!match) {
    console.error('the model did not return JSON; nothing was queued');
    return 1;
  }

  let drafts: TriageDraft[];
  try {
    drafts = JSON.parse(match[0]) as TriageDraft[];
  } catch (error) {
    console.error(`could not parse the draft: ${(error as Error).message}`);
    return 1;
  }

  // Deterministic validation of a model-produced payload. Anything that does not name a real
  // control, or that arrives without a rationale, is dropped rather than queued — a proposal
  // nobody can evaluate wastes the reviewer's attention, which is the scarce resource here.
  let queued = 0;
  for (const draft of drafts) {
    if (!controls.some((c) => c.id === draft.control_id)) {
      console.error(`  dropped: ${draft.control_id} is not a control in this catalog`);
      continue;
    }
    if (!draft.rationale || draft.rationale.length < 20) {
      console.error(`  dropped: ${draft.control_id} arrived without a usable rationale`);
      continue;
    }
    const proposal = queue.propose({
      kind: 'remediation',
      title: draft.title,
      rationale: draft.rationale,
      controlId: draft.control_id,
      payload: { change: draft.change },
      model,
    });
    console.log(`  queued ${proposal.id}  ${proposal.controlId}  ${proposal.title}`);
    queued += 1;
  }

  console.log(`\n${queued} proposal(s) queued, 0 applied. Review with:`);
  console.log('  proofplane-operator list');
  return 0;
}

function cmdList(queue: ProposalQueue, args: Map<string, string>): number {
  const status = args.get('status') ?? 'pending';
  const items = status === 'all' ? queue.all() : queue.all().filter((p) => p.status === status);
  const chain = queue.verify();

  console.log(`proposal queue — chain ${chain.intact ? 'intact' : `BROKEN at ${chain.brokenAt}`}`);
  console.log(`${items.length} ${status} of ${queue.all().length} total\n`);

  for (const p of items) {
    console.log(`  ${p.id}  [${p.status}]  ${p.kind}  ${p.controlId ?? '-'}`);
    console.log(`      ${p.title}`);
    console.log(`      origin=${p.origin} model=${p.model}`);
    if (p.decidedBy) console.log(`      decided by ${p.decidedBy}: ${p.decisionNote}`);
    console.log();
  }
  return 0;
}

function cmdDecide(
  queue: ProposalQueue,
  action: 'approve' | 'reject',
  args: Map<string, string>,
  id: string,
): number {
  const operator = args.get('operator') ?? '';
  const note = args.get('note') ?? '';
  if (!operator) {
    console.error('--operator is required: an anonymous decision is not oversight');
    return 2;
  }
  const proposal =
    action === 'approve' ? queue.approve(id, operator, note) : queue.reject(id, operator, note);
  console.log(`${proposal.id} ${proposal.status} by ${proposal.decidedBy}`);
  console.log(
    'Recorded only. Applying an approved proposal is a separate, deliberate edit to the ' +
      'catalog — the queue does not write to it.',
  );
  return 0;
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags };
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const repo = Repo.locate(process.env.PROOFPLANE_ROOT ?? process.cwd());
  const queue = new ProposalQueue(repo.root);

  switch (command) {
    case 'triage':
      return cmdTriage(repo, queue, flags);
    case 'list':
      return cmdList(queue, flags);
    case 'approve':
    case 'reject': {
      const id = positional[0];
      if (!id) {
        console.error(`usage: proofplane-operator ${command} <proposal-id> --operator "<name>" --note "<why>"`);
        return 2;
      }
      return cmdDecide(queue, command, flags, id);
    }
    default:
      console.log('proofplane-operator');
      console.log('  triage   [--configuration guarded|unguarded]   draft remediations into the queue');
      console.log('  list     [--status pending|approved|rejected|all]');
      console.log('  approve  <id> --operator "<name>" --note "<why>"');
      console.log('  reject   <id> --operator "<name>" --note "<why>"');
      console.log();
      console.log('The MCP server is a separate entry point: node dist/mcp/server.js');
      console.log('Approving is deliberately not available there.');
      return command === 'help' ? 0 : 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
