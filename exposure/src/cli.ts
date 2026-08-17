#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bindToEvidence, loadScenarios } from './bind.js';
import { loadBenchmarks } from './model/benchmarks.js';
import { simulate, shapleyValueOfEachControl, valueOfEachControl } from './model/simulate.js';
import { render } from './report.js';

/**
 * proofplane-exposure — price the register against what the assurance run established.
 *
 *   proofplane-exposure --root . --out evidence/exposure.json --html evidence/exposure.html
 *
 * Refuses to run without evidence. A loss model that prices controls nobody tested is the
 * spreadsheet this repository exists to argue with.
 */

function locateRoot(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'catalog', 'controls'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`no proofplane repository found at or above ${start}`);
}

function flag(argv: string[], name: string, fallback = ''): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : fallback;
}

function boolFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function money(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function main(): number {
  const argv = process.argv.slice(2);
  const root = locateRoot(flag(argv, 'root', process.cwd()));
  const configuration = flag(argv, 'configuration', 'guarded') === 'unguarded'
    ? 'unguarded'
    : 'guarded';

  const scenarioPath = flag(argv, 'scenarios', join(root, 'exposure', 'scenarios.json'));
  const file = loadScenarios(scenarioPath);

  // Optional and vendored. Absent, the report simply omits the cross-check rather than failing:
  // the exposure figures do not depend on it, and a missing yardstick is not a broken run.
  const benchmarks = loadBenchmarks(flag(argv, 'benchmarks', join(root, 'exposure', 'benchmarks.json')));
  const state = bindToEvidence(root, file, configuration);

  const iterations = Number(flag(argv, 'iterations', String(file.iterations)));
  const { seed, scenarios } = file;

  // Inherent is the same model with nothing credited — not a separate set of numbers. The
  // difference between the two is therefore attributable entirely to control state.
  const inherent = simulate({ scenarios, holding: new Set(), iterations, seed });
  const residual = simulate({ scenarios, holding: state.holding, iterations, seed });
  const controlValues = valueOfEachControl(scenarios, state.holding, iterations, seed);

  // Opt-in: exact Shapley is 2^n full simulation runs (4,096 for a 12-control register) and runs
  // at its own, typically-reduced iteration count rather than the caller's — see EXACT_SHAPLEY_LIMIT.
  const runShapley = boolFlag(argv, 'shapley');
  const shapleyIterations = Number(flag(argv, 'shapley-iterations', '2000'));
  const shapley = runShapley
    ? shapleyValueOfEachControl(scenarios, state.holding, shapleyIterations, seed)
    : undefined;

  console.log(`configuration   ${configuration}`);
  console.log(`evidence        run ${state.runId}, head ${state.headHash.slice(0, 16)}…`);
  console.log(`model           ${state.model.provider}:${state.model.id}` +
    `${state.model.pinned ? ' (pinned)' : ' (UNPINNED)'}`);
  console.log(`controls        ${state.holding.size} holding, ${state.breached.length} breached` +
    `${state.unassessed.length ? `, ${state.unassessed.length} priced but unassessed` : ''}`);
  console.log(`iterations      ${iterations.toLocaleString()}  seed ${seed}`);
  console.log();
  console.log(`  inherent   mean ${money(inherent.portfolio.mean).padStart(9)}   ` +
    `P90 ${money(inherent.portfolio.p90).padStart(9)}   P99 ${money(inherent.portfolio.p99)}`);
  console.log(`  residual   mean ${money(residual.portfolio.mean).padStart(9)}   ` +
    `P90 ${money(residual.portfolio.p90).padStart(9)}   P99 ${money(residual.portfolio.p99)}`);
  console.log(`  difference      ${money(inherent.portfolio.mean - residual.portfolio.mean).padStart(9)}` +
    `   (${(((inherent.portfolio.mean - residual.portfolio.mean) / inherent.portfolio.mean) * 100).toFixed(1)}% of inherent)`);
  console.log();
  console.log('  what each control is worth per year (counterfactual; these do not sum)');
  for (const c of controlValues) {
    console.log(`    ${c.controlId}  ${money(c.annualValue).padStart(9)}  ` +
      `${c.scenariosAffected.join(' ')}`);
  }

  if (shapley) {
    console.log();
    console.log(`  shapley value per control (${shapley.method}, ` +
      `${shapley.coalitionsEvaluated.toLocaleString()} coalitions` +
      `${shapley.samples ? `, ${shapley.samples.toLocaleString()} samples` : ''}, ` +
      `${shapleyIterations.toLocaleString()} iterations each — sums to the difference)`);
    for (const v of shapley.values) {
      console.log(`    ${v.controlId}  ${money(v.shapleyValue).padStart(9)}  ` +
        `${(v.shareOfReduction * 100).toFixed(1)}%`);
    }
    console.log(`    ${'total'.padEnd(7)} ${money(shapley.totalAllocated).padStart(9)}` +
      `  (difference: ${money(shapley.totalReduction)})`);
  }

  if (!state.evidenceFromLiveModel) {
    console.log();
    console.log('  NOTE: evidence came from the deterministic model double. These figures are a');
    console.log('  statement about the guardrails, not about a deployed system.');
  }

  const payload = {
    schema: 'proofplane.exposure/v1',
    currency: file.currency,
    iterations,
    seed,
    configuration,
    evidence: {
      run_id: state.runId,
      recorded_at: state.recordedAt,
      head_hash: state.headHash,
      model: state.model,
      from_live_model: state.evidenceFromLiveModel,
      holding: [...state.holding].sort(),
      breached: state.breached,
      unassessed: state.unassessed,
    },
    inherent: inherent.portfolio,
    residual: residual.portfolio,
    difference: inherent.portfolio.mean - residual.portfolio.mean,
    scenarios: residual.scenarios.map((r, i) => ({
      id: r.id,
      title: r.title,
      inherent: inherent.scenarios[i]!.summary,
      residual: r.summary,
      credited: r.appliedControls,
      uncredited: r.ignoredControls,
    })),
    control_values: controlValues,
    ...(shapley
      ? {
          shapley_values: {
            method: shapley.method,
            coalitions_evaluated: shapley.coalitionsEvaluated,
            ...(shapley.samples !== undefined ? { samples: shapley.samples } : {}),
            iterations: shapleyIterations,
            values: shapley.values,
            total_allocated: shapley.totalAllocated,
            total_reduction: shapley.totalReduction,
          },
        }
      : {}),
    caveat:
      'Control-effectiveness figures are judgments carried as three-point estimates. Frequency ' +
      'and magnitude are anchored on generic breach-cost reporting, not AI-specific incident ' +
      'data. Control values are counterfactual and do not sum to the difference' +
      (shapley ? '; shapley_values do, by construction.' : '.'),
  };

  const jsonOut = flag(argv, 'out', join(root, 'evidence', 'exposure.json'));
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\nwritten to ${jsonOut}`);

  const htmlOut = flag(argv, 'html', join(root, 'evidence', 'exposure.html'));
  if (htmlOut !== 'none') {
    mkdirSync(dirname(htmlOut), { recursive: true });
    writeFileSync(
      htmlOut,
      render({
        state,
        inherent,
        residual,
        controlValues,
        shapley,
        iterations,
        currency: file.currency,
        scenarios: file.scenarios,
        benchmarks,
      }),
      'utf8',
    );
    console.log(`report  ${htmlOut}`);
  }

  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
