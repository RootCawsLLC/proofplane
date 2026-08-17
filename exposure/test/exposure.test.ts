import { describe, expect, it } from 'vitest';
import { poisson, percentile, seeded, summarise, triangular, validateThreePoint } from '../src/model/distributions.js';
import {
  shapleyValueExact,
  shapleyValueOfEachControl,
  shapleyValueSampled,
  simulate,
  valueOfEachControl,
} from '../src/model/simulate.js';
import type { Scenario } from '../src/model/scenario.js';
import { loadBenchmarks, lossTypeFor, positionInBand } from '../src/model/benchmarks.js';
import { render } from '../src/report.js';
import { bindToEvidence, loadScenarios } from '../src/bind.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function root(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'catalog', 'controls'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('repo not found');
}

const REPO = root();

describe('sampling', () => {
  it('is reproducible from a seed', () => {
    const a = seeded(42);
    const b = seeded(42);
    for (let i = 0; i < 50; i += 1) expect(a()).toBe(b());
  });

  it('produces different streams for different seeds', () => {
    expect(seeded(1)()).not.toBe(seeded(2)());
  });

  it('keeps triangular samples inside their bounds and near the mode', () => {
    const rand = seeded(7);
    const t = { min: 10, mode: 20, max: 100 };
    const samples = Array.from({ length: 20000 }, () => triangular(rand, t));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...samples)).toBeLessThanOrEqual(100);
    // Mean of a triangular is (min+mode+max)/3 ≈ 43.3
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(41);
    expect(mean).toBeLessThan(46);
  });

  it('handles a degenerate three-point estimate', () => {
    expect(triangular(seeded(1), { min: 5, mode: 5, max: 5 })).toBe(5);
  });

  it('rejects an incoherent three-point estimate', () => {
    expect(() => validateThreePoint({ min: 10, mode: 5, max: 20 }, 'x')).toThrow(/min <= mode/);
    expect(() => validateThreePoint({ min: -1, mode: 0, max: 1 }, 'x')).toThrow(/negative/);
  });

  it('draws Poisson counts with the right mean', () => {
    const rand = seeded(11);
    const counts = Array.from({ length: 20000 }, () => poisson(rand, 3));
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(mean).toBeGreaterThan(2.85);
    expect(mean).toBeLessThan(3.15);
  });

  it('switches to a normal approximation above the exact limit and keeps the mean', () => {
    // S-03 runs at up to 200 events a year, so this branch is exercised by the real register,
    // not just by tests. Both mean and variance must survive the switch.
    const rand = seeded(13);
    const counts = Array.from({ length: 20000 }, () => poisson(rand, 120));
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance =
      counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    expect(mean).toBeGreaterThan(118);
    expect(mean).toBeLessThan(122);
    // For a Poisson, variance ≈ mean.
    expect(variance).toBeGreaterThan(100);
    expect(variance).toBeLessThan(145);
  });

  it('never returns a negative count from the approximation', () => {
    const rand = seeded(3);
    for (let i = 0; i < 5000; i += 1) {
      expect(poisson(rand, 31)).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports quiet years, which a mean hides', () => {
    const s = summarise([0, 0, 0, 0, 100]);
    expect(s.quietYears).toBe(0.8);
    expect(s.mean).toBe(20);
    expect(s.p50).toBe(0);
  });

  it('takes percentiles by nearest rank', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 100)).toBe(10);
  });
});

const scenario: Scenario = {
  id: 'T-01',
  title: 'test',
  description: '',
  frequency: { min: 4, mode: 6, max: 8 },
  magnitude: { min: 1000, mode: 1000, max: 1000 },
  estimateBasis: '',
  effects: [
    {
      controlId: 'C-A',
      dimension: 'frequency',
      reduction: { min: 0.9, mode: 0.9, max: 0.9 },
      basis: '',
    },
  ],
};

describe('simulation', () => {
  const opts = { scenarios: [scenario], iterations: 4000, seed: 99 };

  it('is deterministic for the same inputs', () => {
    const a = simulate({ ...opts, holding: new Set(['C-A']) });
    const b = simulate({ ...opts, holding: new Set(['C-A']) });
    expect(a.portfolio).toEqual(b.portfolio);
  });

  it('credits a control only when it is holding', () => {
    const withControl = simulate({ ...opts, holding: new Set(['C-A']) });
    const without = simulate({ ...opts, holding: new Set() });
    // A 90% frequency reduction should cut expected loss by roughly an order of magnitude.
    expect(withControl.portfolio.mean).toBeLessThan(without.portfolio.mean * 0.2);
  });

  it('ignores a control the evidence never credited', () => {
    const a = simulate({ ...opts, holding: new Set(['C-SOMETHING-ELSE']) });
    const b = simulate({ ...opts, holding: new Set() });
    expect(a.portfolio.mean).toBe(b.portfolio.mean);
  });

  it('records which controls were applied and which were ignored', () => {
    const result = simulate({ ...opts, holding: new Set() });
    expect(result.scenarios[0]!.ignoredControls).toEqual(['C-A']);
    expect(result.scenarios[0]!.appliedControls).toEqual([]);
  });

  it('caps combined reduction so overlapping controls cannot reach certainty', () => {
    const many: Scenario = {
      ...scenario,
      effects: Array.from({ length: 8 }, (_, i) => ({
        controlId: `C-${i}`,
        dimension: 'frequency' as const,
        reduction: { min: 0.8, mode: 0.8, max: 0.8 },
        basis: '',
      })),
    };
    const holding = new Set(many.effects.map((e) => e.controlId));
    const guarded = simulate({ scenarios: [many], holding, iterations: 4000, seed: 5 });
    const bare = simulate({ scenarios: [many], holding: new Set(), iterations: 4000, seed: 5 });
    // Unbounded multiplication of eight 0.8 reductions would leave 0.0000017 of the risk.
    // The cap holds it at 2%.
    expect(guarded.portfolio.mean).toBeGreaterThan(bare.portfolio.mean * 0.015);
  });

  it('rejects a reduction above 1', () => {
    const impossible: Scenario = {
      ...scenario,
      effects: [{ controlId: 'C-A', dimension: 'frequency', reduction: { min: 0, mode: 0.5, max: 1.4 }, basis: '' }],
    };
    expect(() =>
      simulate({ scenarios: [impossible], holding: new Set(['C-A']), iterations: 10, seed: 1 }),
    ).toThrow(/above 1/);
  });
});

describe('control valuation', () => {
  it('prices a control by counterfactual', () => {
    const values = valueOfEachControl([scenario], new Set(['C-A']), 4000, 3);
    expect(values).toHaveLength(1);
    expect(values[0]!.controlId).toBe('C-A');
    expect(values[0]!.annualValue).toBeGreaterThan(0);
    expect(values[0]!.scenariosAffected).toEqual(['T-01']);
  });

  it('gives no value to a control that affects nothing', () => {
    const values = valueOfEachControl([scenario], new Set(['C-A', 'C-UNUSED']), 4000, 3);
    const unused = values.find((v) => v.controlId === 'C-UNUSED')!;
    expect(unused.annualValue).toBe(0);
  });
});

// Two controls on the same scenario with different effect sizes — the minimal case where
// marginal (counterfactual) value and Shapley value are known to disagree.
const overlapScenario: Scenario = {
  id: 'T-02',
  title: 'overlap',
  description: '',
  frequency: { min: 10, mode: 10, max: 10 },
  magnitude: { min: 1000, mode: 1000, max: 1000 },
  estimateBasis: '',
  effects: [
    { controlId: 'C-BIG', dimension: 'frequency', reduction: { min: 0.8, mode: 0.8, max: 0.8 }, basis: '' },
    { controlId: 'C-SMALL', dimension: 'frequency', reduction: { min: 0.3, mode: 0.3, max: 0.3 }, basis: '' },
  ],
};

describe('shapley value', () => {
  it('equals the marginal value exactly when there is only one control', () => {
    const marginal = valueOfEachControl([scenario], new Set(['C-A']), 4000, 3);
    const shapley = shapleyValueExact([scenario], new Set(['C-A']), 4000, 3);
    expect(shapley.method).toBe('exact');
    expect(shapley.coalitionsEvaluated).toBe(2); // 2^1
    expect(shapley.values).toHaveLength(1);
    // With one control there is no ordering to average over, so the two methods must agree.
    expect(shapley.values[0]!.shapleyValue).toBeCloseTo(marginal[0]!.annualValue, 6);
  });

  it('sums exactly to the inherent/residual difference for overlapping controls', () => {
    const holding = new Set(['C-BIG', 'C-SMALL']);
    const shapley = shapleyValueExact([overlapScenario], holding, 4000, 11);
    expect(shapley.coalitionsEvaluated).toBe(4); // 2^2
    const sumOfValues = shapley.values.reduce((a, v) => a + v.shapleyValue, 0);
    expect(sumOfValues).toBeCloseTo(shapley.totalReduction, 6);
    expect(shapley.totalAllocated).toBeCloseTo(shapley.totalReduction, 6);
  });

  it('recovers reduction that raw counterfactual value leaves uncredited when controls overlap', () => {
    const holding = new Set(['C-BIG', 'C-SMALL']);
    const marginal = valueOfEachControl([overlapScenario], holding, 4000, 11);
    const shapley = shapleyValueExact([overlapScenario], holding, 4000, 11);
    const marginalSum = marginal.reduce((a, v) => a + v.annualValue, 0);
    // This is the mechanism behind the "these do not sum" warning on valueOfEachControl: two
    // controls covering the same loss each get measured against the OTHER already holding, so
    // neither is credited for the reduction that depends on both. Shapley's efficiency property
    // means its total always equals the measured difference; marginal value's does not.
    expect(shapley.totalAllocated).toBeCloseTo(shapley.totalReduction, 6);
    expect(marginalSum).toBeLessThan(shapley.totalAllocated);
  });

  it('throws above the exact limit rather than silently taking a long time', () => {
    const holding = new Set(Array.from({ length: 15 }, (_, i) => `C-${i}`));
    expect(() => shapleyValueExact([scenario], holding, 100, 1)).toThrow(/coalitions/);
  });

  it('preserves the efficiency property under sampling, even with very few samples', () => {
    const holding = new Set(['C-BIG', 'C-SMALL']);
    const sampled = shapleyValueSampled([overlapScenario], holding, 4000, 11, 3);
    expect(sampled.method).toBe('sampled');
    expect(sampled.samples).toBe(3);
    const sumOfValues = sampled.values.reduce((a, v) => a + v.shapleyValue, 0);
    // Efficiency holds per-permutation (the walk telescopes from nothing-held to everything-held
    // regardless of order), so averaging preserves it exactly — this is not expected to be noisy.
    expect(sumOfValues).toBeCloseTo(sampled.totalReduction, 6);
  });

  it('dispatches to exact for small registers and sampled for large ones', () => {
    const small = shapleyValueOfEachControl([scenario], new Set(['C-A']), 4000, 3);
    expect(small.method).toBe('exact');

    const manyIds = Array.from({ length: 15 }, (_, i) => `C-${i}`);
    const manyScenario: Scenario = {
      ...scenario,
      effects: manyIds.map((id) => ({
        controlId: id,
        dimension: 'frequency' as const,
        reduction: { min: 0.1, mode: 0.1, max: 0.1 },
        basis: '',
      })),
    };
    const large = shapleyValueOfEachControl([manyScenario], new Set(manyIds), 100, 1, { samples: 5 });
    expect(large.method).toBe('sampled');
    expect(large.samples).toBe(5);
  });
});

describe('binding to real evidence', () => {
  const file = loadScenarios(join(REPO, 'exposure', 'scenarios.json'));

  it('credits exactly the controls the guarded run reported HELD', () => {
    const state = bindToEvidence(REPO, file, 'guarded');
    expect(state.holding.size).toBeGreaterThanOrEqual(12);
    expect(state.breached).toEqual([]);
  });

  it('credits nothing from the unguarded run', () => {
    const state = bindToEvidence(REPO, file, 'unguarded');
    expect(state.holding.size).toBe(0);
    expect(state.breached.length).toBeGreaterThanOrEqual(12);
  });

  it('prices every control the register references', () => {
    const state = bindToEvidence(REPO, file, 'guarded');
    expect(state.unassessed).toEqual([]);
  });

  it('carries the model-double scope flag through, so the dollar figure inherits it', () => {
    const state = bindToEvidence(REPO, file, 'guarded');
    expect(state.evidenceFromLiveModel).toBe(false);
  });

  it('shows residual well below inherent against the real evidence', () => {
    const state = bindToEvidence(REPO, file, 'guarded');
    const inherent = simulate({ scenarios: file.scenarios, holding: new Set(), iterations: 5000, seed: file.seed });
    const residual = simulate({ scenarios: file.scenarios, holding: state.holding, iterations: 5000, seed: file.seed });
    expect(residual.portfolio.mean).toBeLessThan(inherent.portfolio.mean * 0.5);
    expect(residual.portfolio.mean).toBeGreaterThan(0);
  });

  it('every effect names a control that exists in the catalog', () => {
    const catalog = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(REPO, 'catalog', 'catalog.json'), 'utf8'),
    ) as { controls: { id: string }[] };
    const known = new Set(catalog.controls.map((c) => c.id));
    for (const s of file.scenarios) {
      for (const e of s.effects) {
        expect(known.has(e.controlId), `${s.id} prices unknown control ${e.controlId}`).toBe(true);
      }
    }
  });

  it('every effect states a basis', () => {
    for (const s of file.scenarios) {
      expect(s.estimateBasis.length, `${s.id} has no estimate basis`).toBeGreaterThan(20);
      for (const e of s.effects) {
        expect(e.basis.length, `${s.id}/${e.controlId} has no basis`).toBeGreaterThan(20);
      }
    }
  });

  it('shapley values sum to the inherent/residual difference on the real register', () => {
    const state = bindToEvidence(REPO, file, 'guarded');
    // Reduced iteration count, per exposure/README.md — exact Shapley is 2^n full simulation
    // runs (2^12 = 4,096 here), and the efficiency check below does not depend on precision.
    const iterations = 300;
    const shapley = shapleyValueOfEachControl(file.scenarios, state.holding, iterations, file.seed);

    expect(shapley.method).toBe('exact');
    expect(shapley.coalitionsEvaluated).toBe(2 ** state.holding.size);
    expect(shapley.totalAllocated).toBeCloseTo(shapley.totalReduction, 4);

    // This is the number valueOfEachControl's own docstring warns cannot be trusted: the sum of
    // its marginal values, compared against the actual measured reduction Shapley recovers.
    const marginal = valueOfEachControl(file.scenarios, state.holding, iterations, file.seed);
    const marginalSum = marginal.reduce((a, v) => a + v.annualValue, 0);
    expect(Math.abs(marginalSum - shapley.totalReduction)).toBeGreaterThan(0);
  }, 20000);
});

describe('generic-loss-type cross-check', () => {
  const band = { min: 100, likely: 500, max: 1000 };

  it('places a value in the right part of the band, including both edges', () => {
    expect(positionInBand(99, band)).toBe('below the published floor');
    expect(positionInBand(100, band)).toBe('between the floor and the central estimate');
    expect(positionInBand(499, band)).toBe('between the floor and the central estimate');
    expect(positionInBand(500, band)).toBe('between the central estimate and the ceiling');
    expect(positionInBand(999, band)).toBe('between the central estimate and the ceiling');
    expect(positionInBand(1000, band)).toBe('above the published ceiling');
  });

  it('resolves a declared loss type and refuses an undeclared one', () => {
    const file = loadBenchmarks(join(REPO, 'exposure', 'benchmarks.json'));
    expect(file).not.toBeNull();
    expect(lossTypeFor(file, 'disclosure')?.benchmarkId).toBeTruthy();
    expect(lossTypeFor(file, null)).toBeNull();
    expect(lossTypeFor(file, 'no-such-type')).toBeNull();
    expect(lossTypeFor(null, 'disclosure')).toBeNull();
  });

  it('carries magnitude only — comparing the frequency bases would be wrong', () => {
    const file = loadBenchmarks(join(REPO, 'exposure', 'benchmarks.json'))!;
    for (const t of file.lossTypes) {
      expect(t.magnitude.min).toBeLessThanOrEqual(t.magnitude.likely);
      expect(t.magnitude.likely).toBeLessThanOrEqual(t.magnitude.max);
      expect((t as unknown as Record<string, unknown>).frequency).toBeUndefined();
      expect(t.sources.every((s) => s.parameter.startsWith('impact.'))).toBe(true);
    }
  });

  it('reports the scenarios with no published analogue instead of dropping them', () => {
    const scenarios = loadScenarios(join(REPO, 'exposure', 'scenarios.json'));
    const benchmarks = loadBenchmarks(join(REPO, 'exposure', 'benchmarks.json'));
    const matched = scenarios.scenarios.filter((s) => lossTypeFor(benchmarks, s.genericLossType));
    const unmatched = scenarios.scenarios.filter((s) => !lossTypeFor(benchmarks, s.genericLossType));

    // Both halves must be non-empty, or the section is not saying anything.
    expect(matched.length).toBeGreaterThan(0);
    expect(unmatched.length).toBeGreaterThan(0);

    // Every scenario must declare the field explicitly, including as null. An absent field would
    // be indistinguishable from "nobody has looked at this one yet".
    for (const s of scenarios.scenarios) {
      expect(Object.hasOwn(s, 'genericLossType')).toBe(true);
    }

    const state = bindToEvidence(REPO, scenarios, 'guarded');
    const simOpts = { scenarios: scenarios.scenarios, iterations: 400, seed: scenarios.seed };
    const inherent = simulate({ ...simOpts, holding: new Set<string>() });
    const residual = simulate({ ...simOpts, holding: state.holding });
    const html = render({
      state,
      inherent,
      residual,
      controlValues: [],
      iterations: 400,
      currency: scenarios.currency,
      scenarios: scenarios.scenarios,
      benchmarks,
    });

    expect(html).toContain('Generic-loss-type cross-check');
    expect(html).toContain(`${matched.length} of ${scenarios.scenarios.length} scenarios`);
    expect(html).toContain('no published band');
    for (const s of scenarios.scenarios) expect(html).toContain(s.id);
  }, 20000);

  it('omits the section entirely when no benchmark file is present', () => {
    const scenarios = loadScenarios(join(REPO, 'exposure', 'scenarios.json'));
    const state = bindToEvidence(REPO, scenarios, 'guarded');
    const simOpts = { scenarios: scenarios.scenarios, iterations: 200, seed: scenarios.seed };
    const inherent = simulate({ ...simOpts, holding: new Set<string>() });
    const residual = simulate({ ...simOpts, holding: state.holding });
    const html = render({
      state,
      inherent,
      residual,
      controlValues: [],
      iterations: 200,
      currency: scenarios.currency,
      scenarios: scenarios.scenarios,
      benchmarks: null,
    });
    expect(html).not.toContain('Generic-loss-type cross-check');
    // and the report is still a report
    expect(html).toContain('Loss exposure');
  }, 20000);
});
