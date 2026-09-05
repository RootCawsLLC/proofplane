import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertHumanAuthority, currentModelContext } from './boundary.js';
import { canonical } from './repo.js';

/**
 * The proposal queue.
 *
 * This is the only path by which anything a model produced can affect the assurance program,
 * and it is one-way: a model may add to the queue, and nothing else. Approving is a human
 * action taken outside any model context, enforced by `assertHumanAuthority` rather than by
 * asking people to be careful.
 *
 * The shape is deliberately the same as PP-C001's approval gate in the target. That control says
 * a model may request a consequential action but must not authorize one; this repository would
 * be worth very little if it audited for that property and did not have it.
 */

export type ProposalKind =
  | 'control-mapping'
  | 'remediation'
  | 'catalog-amendment'
  | 'limitation';

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface Proposal {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly title: string;
  readonly rationale: string;
  /** Which control this bears on, when it bears on one. */
  readonly controlId: string | null;
  /** The change being proposed, as data. Never applied automatically. */
  readonly payload: Record<string, unknown>;
  /** What produced it: an MCP tool name, or "triage" for the autonomous path. */
  readonly origin: string;
  /** Model that produced the judgment, so a proposal can be scoped to one. */
  readonly model: string;
  readonly createdAt: string;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  readonly prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function digest(p: Omit<Proposal, 'hash'>): string {
  return createHash('sha256').update(canonical(p)).digest('hex');
}

export class ProposalQueue {
  private readonly file: string;
  private items: Proposal[] = [];

  constructor(private readonly root: string) {
    this.file = join(root, 'operator', 'proposals', 'queue.json');
    this.load();
  }

  private load(): void {
    if (existsSync(this.file)) {
      this.items = JSON.parse(readFileSync(this.file, 'utf8')) as Proposal[];
    }
  }

  private persist(): void {
    mkdirSync(join(this.root, 'operator', 'proposals'), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.items, null, 2)}\n`, 'utf8');
  }

  private nextId(): string {
    return `prop_${String(this.items.length + 1).padStart(4, '0')}`;
  }

  /**
   * Add a proposal. Callable from model context — that is the whole point of it existing.
   *
   * Timestamps are counter-derived rather than wall-clock so the queue stays byte-reproducible,
   * matching the evidence bundle's approach.
   */
  propose(input: {
    kind: ProposalKind;
    title: string;
    rationale: string;
    controlId: string | null;
    payload: Record<string, unknown>;
    model: string;
  }): Proposal {
    const context = currentModelContext();
    const seq = this.items.length + 1;
    const body: Omit<Proposal, 'hash'> = {
      id: this.nextId(),
      kind: input.kind,
      title: input.title,
      rationale: input.rationale,
      controlId: input.controlId,
      payload: input.payload,
      origin: context?.tool ?? 'triage',
      model: input.model,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 1000).toISOString(),
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      prevHash: this.items.at(-1)?.hash ?? GENESIS,
    };
    const proposal: Proposal = { ...body, hash: digest(body) };
    this.items.push(proposal);
    this.persist();
    return proposal;
  }

  /**
   * Approve a proposal.
   *
   * Guarded first, before any state changes. A partial effect followed by a refusal is worse
   * than a refusal, and this is the operation the whole boundary exists to protect.
   */
  approve(id: string, operator: string, note: string): Proposal {
    assertHumanAuthority('approve a proposal');
    return this.decide(id, 'approved', operator, note);
  }

  reject(id: string, operator: string, note: string): Proposal {
    assertHumanAuthority('reject a proposal');
    return this.decide(id, 'rejected', operator, note);
  }

  private decide(
    id: string,
    status: ProposalStatus,
    operator: string,
    note: string,
  ): Proposal {
    const proposal = this.items.find((p) => p.id === id);
    if (!proposal) throw new Error(`no proposal ${id}`);
    if (proposal.status !== 'pending') {
      throw new Error(`${id} is already ${proposal.status}; decisions are single-use`);
    }
    if (!operator.trim()) {
      throw new Error('an operator identity is required — an anonymous decision is not oversight');
    }
    proposal.status = status;
    proposal.decidedBy = operator;
    proposal.decidedAt = new Date(
      Date.UTC(2026, 0, 1, 12, 0, 0) + this.items.indexOf(proposal) * 1000,
    ).toISOString();
    proposal.decisionNote = note;
    this.persist();
    return proposal;
  }

  all(): readonly Proposal[] {
    return this.items;
  }

  pending(): readonly Proposal[] {
    return this.items.filter((p) => p.status === 'pending');
  }

  get(id: string): Proposal | undefined {
    return this.items.find((p) => p.id === id);
  }

  /** Recompute the chain over the immutable fields. Decisions are recorded, not rewritten. */
  verify(): { intact: boolean; brokenAt: string | null } {
    let prev = GENESIS;
    for (const p of this.items) {
      if (p.prevHash !== prev) return { intact: false, brokenAt: p.id };
      // Strip the stored hash before recomputing — including it would hash the hash.
      const { hash, ...rest } = p;
      const body: Omit<Proposal, 'hash'> = {
        ...rest,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
      };
      if (digest(body) !== hash) return { intact: false, brokenAt: p.id };
      prev = hash;
    }
    return { intact: true, brokenAt: null };
  }
}
