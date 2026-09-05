import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Reads what the assurance pipeline produced. Pure functions over committed files — no network,
 * no model, no writes. Everything the MCP read tools serve comes from here.
 *
 * The catalog is consumed as the JSON snapshot the probe emits rather than by parsing the YAML
 * again. The Python loader validates threat identifiers against catalog/threats/ and constrains
 * crosswalk confidence; a second reader in a second language would be a second set of semantics
 * to keep in step, and they would drift.
 */

export interface Mapping {
  framework: string;
  reference: string;
  reference_kind: string;
  confidence: 'high' | 'medium' | 'low';
  basis: string;
  label?: string;
}

export interface ThreatRef {
  id: string;
  name: string;
  confidence: string;
}

export interface Control {
  id: string;
  title: string;
  guardrail: string;
  statement: string;
  rationale: string;
  limits: string;
  proved_by: string[];
  assertion: Record<string, string>;
  threat: { atlas: ThreatRef[]; owasp_asi: ThreatRef[] };
  crosswalk: Mapping[];
  references: string[];
}

export interface EvidenceRecord {
  probe_id: string;
  control_id: string;
  control_title: string;
  attack: string;
  outcome: 'HELD' | 'BREACHED' | 'ERROR';
  trials: {
    n: number;
    breached: number;
    rate: number;
    errors: number;
    rate_ci95?: [number, number];
    ci_meaningful?: boolean;
  };
  observations: { label: string; detail: string }[];
  hash: string;
  prev_hash: string;
  recorded_at: string;
}

export interface EvidenceBundle {
  run_id: string;
  recorded_at: string;
  target: { base_url: string; guardrails: string[]; model: Record<string, unknown> };
  summary: Record<string, number>;
  head_hash: string;
  records: EvidenceRecord[];
}

export class RepoError extends Error {}

function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) {
    throw new RepoError(
      `${what} not found at ${path}. Run scripts/assure.sh — the operator reports what the ` +
        `pipeline produced and invents nothing when it finds no run.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export class Repo {
  constructor(readonly root: string) {}

  static locate(start: string = process.cwd()): Repo {
    // Walk up looking for the catalog directory, so the server works from anywhere.
    let dir = resolve(start);
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(join(dir, 'catalog', 'controls'))) return new Repo(dir);
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    throw new RepoError(`no proofplane repository found at or above ${start}`);
  }

  controls(): Control[] {
    const snapshot = readJson<{ controls: Control[] }>(
      join(this.root, 'catalog', 'catalog.json'),
      'catalog snapshot',
    );
    return snapshot.controls;
  }

  evidence(configuration: 'guarded' | 'unguarded' = 'guarded'): EvidenceBundle {
    return readJson<EvidenceBundle>(
      join(this.root, 'evidence', configuration, 'evidence.json'),
      `${configuration} evidence`,
    );
  }

  matrix(): {
    guardrails: string[];
    controls: string[];
    expected_breach: Record<string, string>;
    rows: Record<string, Record<string, string>>;
    independent: boolean;
  } {
    return readJson(join(this.root, 'evidence', 'matrix.json'), 'independence matrix');
  }

  limits(): {
    id: string;
    title: string;
    limitation: string;
    outcome: string;
    observations: [string, string][];
  }[] {
    return readJson(join(this.root, 'evidence', 'limits.json'), 'limitation demonstrations');
  }

  aibom(): {
    specVersion: string;
    metadata: { properties: { name: string; value: string }[] };
    components: {
      type: string;
      name: string;
      properties: { name: string; value: string }[];
    }[];
  } {
    return readJson(join(this.root, 'evidence', 'aibom.json'), 'AI bill of materials');
  }

  corroboration(): {
    control_id: string;
    framework: string;
    reference: string;
    status: string;
    scf_controls: number;
    note: string;
  }[] {
    return readJson(
      join(this.root, 'catalog', 'corroboration', 'report.json'),
      'citation corroboration report',
    );
  }

  /**
   * Recompute the evidence chain. Deterministic, and the only honest way to answer "is this
   * evidence intact" — trusting the head hash a file reports about itself is not an answer.
   */
  verifyChain(configuration: 'guarded' | 'unguarded' = 'guarded'): {
    intact: boolean;
    brokenAt: string | null;
    length: number;
    head: string;
  } {
    const bundle = this.evidence(configuration);
    let prev = '0'.repeat(64);

    for (const record of bundle.records) {
      const { hash, ...body } = record as EvidenceRecord & { hash: string };
      if (record.prev_hash !== prev) {
        return {
          intact: false,
          brokenAt: record.probe_id,
          length: bundle.records.length,
          head: bundle.head_hash,
        };
      }
      const recomputed = createHash('sha256')
        .update(canonical({ ...body, prev_hash: record.prev_hash }))
        .digest('hex');
      if (recomputed !== hash) {
        return {
          intact: false,
          brokenAt: record.probe_id,
          length: bundle.records.length,
          head: bundle.head_hash,
        };
      }
      prev = hash;
    }

    return {
      intact: true,
      brokenAt: null,
      length: bundle.records.length,
      head: bundle.head_hash,
    };
  }
}

/**
 * Must match probe/proofplane_probe/evidence.py::canonical exactly, or nothing verifies.
 *
 * Two rules, both load-bearing:
 *   - keys sorted, no whitespace  (Python: sort_keys=True, separators=(",", ":"))
 *   - integral floats as integers (Python normalizes 1.0 to 1 before hashing)
 *
 * The second exists because Python writes a float of 1.0 as `1.0` and JavaScript writes it as
 * `1`. That single difference was enough to make evidence written by the probe unverifiable
 * here — caught by the cross-language test in test/repo.test.ts, which is the only reason
 * anyone should believe the chain is checkable from both sides.
 *
 * JavaScript already renders integral numbers without a decimal point, so the normalization is
 * a no-op on this side. It is written out anyway: the rule belongs in both implementations,
 * not in one implementation and one language's happy accident.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalise((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
