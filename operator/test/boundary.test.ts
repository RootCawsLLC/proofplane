import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeterminismBoundaryError,
  assertHumanAuthority,
  currentModelContext,
  underModelAuthority,
} from '../src/core/boundary.js';
import { ProposalQueue } from '../src/core/proposals.js';
import { TOOLS, findTool } from '../src/tools/index.js';

let root: string;
let queue: ProposalQueue;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proofplane-op-'));
  mkdirSync(join(root, 'catalog', 'controls'), { recursive: true });
  queue = new ProposalQueue(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the determinism boundary', () => {
  it('refuses an approval reached from a model context', async () => {
    const proposal = queue.propose({
      kind: 'remediation',
      title: 't',
      rationale: 'r',
      controlId: 'PP-C001',
      payload: {},
      model: 'test',
    });

    await expect(
      underModelAuthority('propose_remediation', 'inv_1', async () =>
        queue.approve(proposal.id, 'someone', 'because'),
      ),
    ).rejects.toBeInstanceOf(DeterminismBoundaryError);

    expect(queue.get(proposal.id)?.status).toBe('pending');
  });

  it('refuses transitively, through any call depth', async () => {
    // The guard cannot be escaped by putting a few functions between the tool and the decision.
    // AsyncLocalStorage propagates through awaits, so depth does not help.
    const proposal = queue.propose({
      kind: 'remediation', title: 't', rationale: 'r', controlId: null, payload: {}, model: 'test',
    });

    const deep = async (n: number): Promise<unknown> => {
      if (n === 0) return queue.approve(proposal.id, 'someone', 'because');
      await Promise.resolve();
      return deep(n - 1);
    };

    await expect(
      underModelAuthority('some_tool', 'inv_1', () => deep(12)),
    ).rejects.toBeInstanceOf(DeterminismBoundaryError);
  });

  it('names the tool it refused, so the refusal is diagnosable', async () => {
    const proposal = queue.propose({
      kind: 'remediation', title: 't', rationale: 'r', controlId: null, payload: {}, model: 'test',
    });
    try {
      await underModelAuthority('assurance_status', 'inv_9', async () =>
        queue.approve(proposal.id, 'x', 'y'),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DeterminismBoundaryError);
      expect((error as DeterminismBoundaryError).tool).toBe('assurance_status');
      expect((error as Error).message).toContain('may propose this; it may not decide it');
    }
  });

  it('allows the same approval outside a model context', () => {
    const proposal = queue.propose({
      kind: 'remediation', title: 't', rationale: 'r', controlId: null, payload: {}, model: 'test',
    });
    const decided = queue.approve(proposal.id, 'rootcaws', 'reviewed the diff');
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('rootcaws');
  });

  it('leaves no model context behind after a tool returns', async () => {
    await underModelAuthority('t', 'inv_1', async () => {
      expect(currentModelContext()?.tool).toBe('t');
    });
    expect(currentModelContext()).toBeUndefined();
    expect(() => assertHumanAuthority('anything')).not.toThrow();
  });

  it('refuses before mutating, not after', async () => {
    const proposal = queue.propose({
      kind: 'remediation', title: 't', rationale: 'r', controlId: null, payload: {}, model: 'test',
    });
    await underModelAuthority('t', 'inv_1', async () => {
      try { queue.approve(proposal.id, 'x', 'y'); } catch { /* expected */ }
    });
    const after = queue.get(proposal.id)!;
    expect(after.status).toBe('pending');
    expect(after.decidedBy).toBeNull();
    expect(after.decidedAt).toBeNull();
  });
});

describe('the MCP surface', () => {
  it('admits only read and propose effects', () => {
    for (const tool of TOOLS) {
      expect(['read', 'propose']).toContain(tool.effect);
    }
  });

  it('exposes no tool that decides anything', () => {
    // The absence is the control. If a future tool is named for a decision, this fails loudly
    // rather than the boundary quietly becoming a convention again.
    const forbidden = /approve|reject|apply|commit|set_status|write_evidence|emit_oscal|decide/i;
    const offenders = TOOLS.filter((t) => forbidden.test(t.name));
    expect(offenders.map((t) => t.name)).toEqual([]);
  });

  it('has no tool reaching the queue decision methods', () => {
    for (const tool of TOOLS) {
      const source = tool.handler.toString();
      expect(source).not.toMatch(/\.approve\(|\.reject\(/);
    }
  });

  it('declares every tool it can find by name', () => {
    for (const tool of TOOLS) {
      expect(findTool(tool.name)).toBe(tool);
    }
    expect(findTool('nope')).toBeUndefined();
  });

  it('has more read tools than propose tools', () => {
    // Not a rule so much as a smell test: an operator that mostly writes is not an assessor.
    const read = TOOLS.filter((t) => t.effect === 'read').length;
    const propose = TOOLS.filter((t) => t.effect === 'propose').length;
    expect(read).toBeGreaterThan(propose);
  });
});

describe('the proposal queue', () => {
  it('records the originating tool when proposing from a model context', async () => {
    const p = await underModelAuthority('propose_remediation', 'inv_1', async () =>
      queue.propose({
        kind: 'remediation', title: 't', rationale: 'r', controlId: 'PP-C001',
        payload: {}, model: 'claude-sonnet-5',
      }),
    );
    expect(p.origin).toBe('propose_remediation');
    expect(p.model).toBe('claude-sonnet-5');
    expect(p.status).toBe('pending');
  });

  it('labels the autonomous path distinctly', () => {
    const p = queue.propose({
      kind: 'remediation', title: 't', rationale: 'r', controlId: null, payload: {}, model: 'm',
    });
    expect(p.origin).toBe('triage');
  });

  it('will not decide the same proposal twice', () => {
    const p = queue.propose({
      kind: 'remediation', title: 't', rationale: 'r', controlId: null, payload: {}, model: 'm',
    });
    queue.approve(p.id, 'rootcaws', 'ok');
    expect(() => queue.approve(p.id, 'rootcaws', 'again')).toThrow(/single-use/);
    expect(() => queue.reject(p.id, 'rootcaws', 'no')).toThrow(/already approved/);
  });

  it('refuses an anonymous decision', () => {
    const p = queue.propose({
      kind: 'remediation', title: 't', rationale: 'r', controlId: null, payload: {}, model: 'm',
    });
    expect(() => queue.approve(p.id, '   ', 'ok')).toThrow(/operator identity is required/);
  });

  it('chains proposals and detects an edited one', () => {
    queue.propose({ kind: 'remediation', title: 'a', rationale: 'r', controlId: null, payload: {}, model: 'm' });
    queue.propose({ kind: 'remediation', title: 'b', rationale: 'r', controlId: null, payload: {}, model: 'm' });
    expect(queue.verify().intact).toBe(true);

    // Deciding must NOT break the chain — decisions are recorded alongside, not folded in.
    queue.approve('prop_0001', 'rootcaws', 'ok');
    expect(queue.verify().intact).toBe(true);

    // Editing the proposal's substance must.
    (queue.all()[0] as { title: string }).title = 'rewritten';
    const broken = queue.verify();
    expect(broken.intact).toBe(false);
    expect(broken.brokenAt).toBe('prop_0001');
  });
});
