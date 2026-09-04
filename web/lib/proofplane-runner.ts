/**
 * Server-only bridge to the real proofplane tool.
 *
 * It does NOT reimplement or import the tool into the Next bundle. It spawns a plain Node ESM
 * process (scripts/run-assure.mjs) that boots the shipped target server and runs the shipped
 * Python probe suite (and the exposure CLI) against it, then relays that process's JSON result.
 * Running out-of-process keeps the tool's child-process and filesystem behaviour identical to
 * the CLI and isolates the (server-spawning, Python-spawning) run from the web server.
 */
import 'server-only';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface RunRequest {
  /** Run the counterfactual suite against the unguarded target. Default true. */
  unguarded?: boolean;
  /** Run the 12x12 independence matrix against the guarded target. Default true. */
  matrix?: boolean;
  /** Price the FAIR loss model against the guarded evidence. Default true. */
  exposure?: boolean;
}

/* ---- shapes of the shipped tool's JSON output (only fields the UI renders) ---- */
export interface Trials {
  n: number;
  breached: number;
  rate: number;
  errors: number;
  rate_ci95: [number, number];
  ci_meaningful: boolean;
}
export interface ThreatRef {
  id: string;
  name: string;
  confidence: string;
}
export interface CrosswalkRef {
  framework: string;
  reference: string;
  reference_kind: string;
  confidence: string;
  basis: string;
  label: string;
}
export interface EvidenceRecord {
  probe_id: string;
  control_id: string;
  control_title: string;
  attack: string;
  assertion: { type: string; passes_when: string; fails_when: string };
  outcome: 'HELD' | 'BREACHED' | 'ERROR';
  trials: Trials;
  threat: { atlas: ThreatRef[]; owasp_asi: ThreatRef[] };
  crosswalk: CrosswalkRef[];
  observations: { label: string; detail: string }[];
  error: string | null;
}
export interface EvidenceBundle {
  run_id: string;
  recorded_at: string;
  target: {
    base_url: string;
    guardrails: string[];
    model: { provider: string; id: string; pinned: boolean };
  };
  summary: { HELD: number; BREACHED: number; ERROR: number };
  head_hash: string;
  records: EvidenceRecord[];
}
export interface MatrixResult {
  target: string;
  guardrails: string[];
  controls: string[];
  expected_breach: Record<string, string>;
  rows: Record<string, Record<string, 'HELD' | 'BREACHED' | 'ERROR'>>;
  independent: boolean;
}
export interface ExposureResult {
  currency: string;
  iterations: number;
  seed: number;
  evidence: {
    run_id: string;
    head_hash: string;
    model: { provider?: string; id?: string; pinned?: boolean };
    from_live_model: boolean;
    holding: string[];
    breached: string[];
  };
  inherent: { mean: number; p90: number; p99: number };
  residual: { mean: number; p90: number; p99: number };
  difference: number;
  scenarios: {
    id: string;
    title: string;
    inherent: { mean: number };
    residual: { mean: number };
    credited: string[];
    uncredited: string[];
  }[];
  control_values: { controlId: string; annualValue: number; scenariosAffected: string[] }[];
  caveat: string;
}
export interface RunResult {
  guarded: EvidenceBundle;
  unguarded: EvidenceBundle | null;
  matrix: MatrixResult | null;
  exposure: ExposureResult | null;
  operatorNotes: string[];
  trials: number;
  durationMs: number;
}

function scriptPath(): string {
  return process.env.ASSURE_SCRIPT ?? join(process.cwd(), 'scripts', 'run-assure.mjs');
}

const HARD_TIMEOUT_MS = 290_000;

export async function runProofplane(req: RunRequest): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath()], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Assurance run timed out.'));
    }, HARD_TIMEOUT_MS);

    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(killer);
      let parsed: (RunResult & { error?: string }) | null = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        reject(new Error(`Assurance process produced no valid result.${err ? ` (${err.slice(0, 400)})` : ''}`));
        return;
      }
      if (parsed && parsed.error) {
        reject(new Error(parsed.error.split('\n')[0]));
        return;
      }
      resolve(parsed as RunResult);
    });

    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}
