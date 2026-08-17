import { describe, expect, it } from 'vitest';
import { Repo, canonical } from '../src/core/repo.js';
import { ProposalQueue } from '../src/core/proposals.js';
import { TOOLS } from '../src/tools/index.js';
import { underModelAuthority } from '../src/core/boundary.js';

const repo = Repo.locate(process.cwd());

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name)!;
  return underModelAuthority(tool.name, 'test', () =>
    tool.handler(args, { repo, queue: new ProposalQueue(repo.root), model: 'test' }),
  );
}

describe('reading what the pipeline produced', () => {
  it('finds the repository from the operator directory', () => {
    expect(repo.root).toBeTruthy();
    expect(repo.controls().length).toBeGreaterThanOrEqual(12);
  });

  it('verifies the evidence chain produced by the Python probe', () => {
    // The real cross-language check. This recomputes SHA-256 over a canonical JSON encoding in
    // TypeScript and compares it to hashes written by probe/proofplane_probe/evidence.py. If the
    // two canonical encoders ever disagree — key ordering, separators, unicode escaping — this
    // fails, and it fails before anyone trusts a chain that only one side can verify.
    const result = repo.verifyChain('guarded');
    expect(result.intact, `chain broken at ${result.brokenAt}`).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(12);
    expect(result.head).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies the unguarded chain too', () => {
    expect(repo.verifyChain('unguarded').intact).toBe(true);
  });

  it('canonical encoding sorts keys and emits no spaces', () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonical([3, 1])).toBe('[3,1]');
  });
});

describe('read tools', () => {
  it('reports assurance status with trial counts', async () => {
    const status = (await call('assurance_status')) as {
      summary: Record<string, number>;
      controls: { control_id: string; outcome: string; trials: { n: number } }[];
    };
    expect(status.summary.HELD).toBeGreaterThanOrEqual(12);
    for (const c of status.controls) {
      expect(c.outcome).toBe('HELD');
      expect(c.trials.n).toBeGreaterThan(0);
    }
  });

  it('flags that a double-backed result is scoped to the guardrail', async () => {
    const status = (await call('assurance_status')) as {
      controls: { scope_note?: string }[];
    };
    expect(status.controls[0]?.scope_note).toContain('not about any model');
  });

  it('reports the unguarded run as fully breached', async () => {
    const status = (await call('assurance_status', { configuration: 'unguarded' })) as {
      summary: Record<string, number>;
    };
    expect(status.summary.BREACHED).toBeGreaterThanOrEqual(12);
  });

  it('confirms the independence matrix diagonal', async () => {
    const matrix = (await call('independence_matrix')) as {
      independent: boolean;
      rows: Record<string, Record<string, string>>;
      expected_breach: Record<string, string>;
    };
    expect(matrix.independent).toBe(true);
    for (const [guardrail, outcomes] of Object.entries(matrix.rows)) {
      const shouldBreach = matrix.expected_breach[guardrail];
      for (const [controlId, outcome] of Object.entries(outcomes)) {
        expect(outcome).toBe(controlId === shouldBreach ? 'BREACHED' : 'HELD');
      }
    }
  });

  it('states that coverage is not satisfaction', async () => {
    const coverage = (await call('coverage_by_framework')) as {
      note: string;
      citations_unresolved: number;
      frameworks: { framework: string; mappings: number }[];
    };
    expect(coverage.note).toContain('does not mean the requirement is satisfied');
    expect(coverage.citations_unresolved).toBe(0);
    expect(coverage.frameworks.length).toBeGreaterThanOrEqual(6);
  });

  it('filters controls by framework', async () => {
    const eu = (await call('list_controls', { framework: 'EU AI Act' })) as unknown[];
    const all = (await call('list_controls')) as unknown[];
    expect(eu.length).toBeGreaterThan(0);
    expect(eu.length).toBeLessThan(all.length);
  });

  it('returns a control in full and rejects an unknown one', async () => {
    const control = (await call('get_control', { control_id: 'PP-C001' })) as {
      id: string;
      crosswalk: unknown[];
    };
    expect(control.id).toBe('PP-C001');
    expect(control.crosswalk.length).toBeGreaterThan(0);
    await expect(call('get_control', { control_id: 'PP-C999' })).rejects.toThrow(/no control/);
  });

  it('surfaces the AI inventory with provenance', async () => {
    const inventory = (await call('ai_inventory')) as {
      components: { name: string; declared: boolean; first_seen?: string }[];
    };
    expect(inventory.components.length).toBeGreaterThan(0);
    for (const c of inventory.components) {
      expect(c.first_seen, `${c.name} has no provenance`).toBeTruthy();
    }
  });

  it('reports the executed limitation demonstrations', async () => {
    const limits = (await call('documented_limitations')) as { id: string; outcome: string }[];
    expect(limits.length).toBeGreaterThan(0);
    // ESCALATED would mean a documented weakness was bypassed AND the control behind it failed.
    expect(limits.some((l) => l.outcome === 'ESCALATED')).toBe(false);
  });
});

describe('propose tools', () => {
  it('refuses a mapping proposal against a control that does not exist', async () => {
    await expect(
      call('propose_control_mapping', {
        control_id: 'PP-C999', framework: 'EU AI Act', reference: 'Article 5',
        reference_kind: 'article', confidence: 'low',
        basis: 'a sufficiently long basis string for the validator',
      }),
    ).rejects.toThrow(/no control/);
  });

  it('refuses a mapping proposal with a basis too short to be one', async () => {
    await expect(
      call('propose_control_mapping', {
        control_id: 'PP-C001', framework: 'EU AI Act', reference: 'Article 5',
        reference_kind: 'article', confidence: 'low', basis: 'seems right',
      }),
    ).rejects.toThrow(/too short to be a basis/);
  });

  it('refuses a remediation for a control that does not exist', async () => {
    await expect(
      call('propose_remediation', {
        control_id: 'PP-C999', title: 't',
        rationale: 'a long enough rationale to pass', change: 'c',
      }),
    ).rejects.toThrow(/no control/);
  });
});
