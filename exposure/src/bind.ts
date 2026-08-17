import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScenarioFile } from './model/scenario.js';

/**
 * Joins the risk register to what the assurance run actually found.
 *
 * This is the whole point of the component. A control is credited in the loss model only if a
 * probe executed an attack against it and the attack failed — not because it is written down,
 * not because it is deployed, not because someone believes it works. When a guardrail stops
 * holding, its credit disappears and the dollar figure moves on the next run.
 */

export interface EvidenceRecord {
  control_id: string;
  control_title: string;
  outcome: 'HELD' | 'BREACHED' | 'ERROR';
  trials: { n: number; breached: number; ci_meaningful?: boolean; rate_ci95?: [number, number] };
}

export interface BoundState {
  readonly holding: Set<string>;
  readonly breached: string[];
  readonly errored: string[];
  readonly runId: string;
  readonly recordedAt: string;
  readonly guardrails: string[];
  readonly model: { provider?: string; id?: string; pinned?: boolean };
  readonly headHash: string;
  /**
   * True when the evidence came from a live model rather than the deterministic double.
   *
   * Carried all the way into the exposure output on purpose. Everything downstream inherits the
   * scope of the evidence underneath it, and a dollar figure derived from a double is a
   * statement about the guardrails, not about a deployed system.
   */
  readonly evidenceFromLiveModel: boolean;
  /** Controls the register prices but the evidence never assessed. */
  readonly unassessed: string[];
}

export function loadScenarios(path: string): ScenarioFile {
  if (!existsSync(path)) throw new Error(`no scenario file at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as ScenarioFile;
}

export function bindToEvidence(
  root: string,
  scenarios: ScenarioFile,
  configuration: 'guarded' | 'unguarded' = 'guarded',
): BoundState {
  const path = join(root, 'evidence', configuration, 'evidence.json');
  if (!existsSync(path)) {
    throw new Error(
      `no ${configuration} evidence at ${path}. Run scripts/assure.sh — this component prices ` +
        `what a run established and refuses to price anything else.`,
    );
  }

  const bundle = JSON.parse(readFileSync(path, 'utf8')) as {
    run_id: string;
    recorded_at: string;
    head_hash: string;
    target: { guardrails: string[]; model: { provider?: string; id?: string; pinned?: boolean } };
    records: EvidenceRecord[];
  };

  const holding = new Set<string>();
  const breached: string[] = [];
  const errored: string[] = [];

  for (const record of bundle.records) {
    if (record.outcome === 'HELD') holding.add(record.control_id);
    else if (record.outcome === 'BREACHED') breached.push(record.control_id);
    else errored.push(record.control_id);
  }

  const priced = new Set(
    scenarios.scenarios.flatMap((s) => s.effects.map((e) => e.controlId)),
  );
  const assessed = new Set(bundle.records.map((r) => r.control_id));
  const unassessed = [...priced].filter((id) => !assessed.has(id)).sort();

  return {
    holding,
    breached: breached.sort(),
    errored: errored.sort(),
    runId: bundle.run_id,
    recordedAt: bundle.recorded_at,
    guardrails: bundle.target.guardrails,
    model: bundle.target.model,
    headHash: bundle.head_hash,
    evidenceFromLiveModel: bundle.records.some((r) => r.trials.ci_meaningful === true),
    unassessed,
  };
}
