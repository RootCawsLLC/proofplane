import {
  poisson,
  seeded,
  summarise,
  triangular,
  validateThreePoint,
  type Summary,
} from './distributions.js';
import { MAX_COMBINED_REDUCTION, type Scenario } from './scenario.js';

/**
 * Monte Carlo over the register.
 *
 * Each iteration is one simulated year: draw a rate, draw a Poisson count from it, draw a
 * magnitude per event, sum. Controls that are currently holding reduce the rate or the magnitude
 * by a sampled proportion. Iterations are summed across scenarios *within* the same year before
 * being aggregated, so the portfolio percentiles are percentiles of total annual loss rather
 * than a sum of per-scenario percentiles — those are different numbers and the second one is
 * wrong.
 */

export interface SimulationInput {
  readonly scenarios: Scenario[];
  /** Controls currently HELD. Anything absent gets no credit. */
  readonly holding: ReadonlySet<string>;
  readonly iterations: number;
  readonly seed: number;
}

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly summary: Summary;
  readonly appliedControls: string[];
  readonly ignoredControls: string[];
}

export interface SimulationResult {
  readonly portfolio: Summary;
  readonly scenarios: ScenarioResult[];
  readonly iterations: number;
}

function combinedReduction(samples: number[]): number {
  let residual = 1;
  for (const r of samples) residual *= 1 - r;
  return Math.min(1 - residual, MAX_COMBINED_REDUCTION);
}

export function simulate(input: SimulationInput): SimulationResult {
  const { scenarios, holding, iterations, seed } = input;

  for (const scenario of scenarios) {
    validateThreePoint(scenario.frequency, `${scenario.id} frequency`);
    validateThreePoint(scenario.magnitude, `${scenario.id} magnitude`);
    for (const effect of scenario.effects) {
      validateThreePoint(effect.reduction, `${scenario.id} ${effect.controlId} reduction`);
      if (effect.reduction.max > 1) {
        throw new Error(
          `${scenario.id} ${effect.controlId}: a reduction above 1 would mean the control ` +
            `creates value out of the loss it prevents`,
        );
      }
    }
  }

  // One generator for the whole run, consumed in a fixed order, so the result is a pure
  // function of (scenarios, holding, iterations, seed).
  const rand = seeded(seed);

  const perScenarioLosses = scenarios.map(() => [] as number[]);
  const portfolioLosses: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    let yearTotal = 0;

    for (let s = 0; s < scenarios.length; s += 1) {
      const scenario = scenarios[s]!;
      const active = scenario.effects.filter((e) => holding.has(e.controlId));

      const freqReductions: number[] = [];
      const magReductions: number[] = [];
      for (const effect of active) {
        const sample = triangular(rand, effect.reduction);
        (effect.dimension === 'frequency' ? freqReductions : magReductions).push(sample);
      }

      const rate = triangular(rand, scenario.frequency) * (1 - combinedReduction(freqReductions));
      const events = poisson(rand, rate);

      let loss = 0;
      const magnitudeFactor = 1 - combinedReduction(magReductions);
      for (let e = 0; e < events; e += 1) {
        loss += triangular(rand, scenario.magnitude) * magnitudeFactor;
      }

      perScenarioLosses[s]!.push(loss);
      yearTotal += loss;
    }

    portfolioLosses.push(yearTotal);
  }

  return {
    iterations,
    portfolio: summarise(portfolioLosses),
    scenarios: scenarios.map((scenario, index) => ({
      id: scenario.id,
      title: scenario.title,
      summary: summarise(perScenarioLosses[index]!),
      appliedControls: scenario.effects
        .filter((e) => holding.has(e.controlId))
        .map((e) => e.controlId),
      ignoredControls: scenario.effects
        .filter((e) => !holding.has(e.controlId))
        .map((e) => e.controlId),
    })),
  };
}

export interface ControlValue {
  readonly controlId: string;
  /** Expected annual loss with every currently-holding control in place. */
  readonly withControl: number;
  /** The same, with this one control removed and everything else unchanged. */
  readonly withoutControl: number;
  /** The difference: what this control is worth per year, in currency. */
  readonly annualValue: number;
  /** Same comparison at the 90th percentile, which is what a reserve is sized against. */
  readonly p90WithControl: number;
  readonly p90WithoutControl: number;
  readonly scenariosAffected: string[];
}

/**
 * What each control is worth, by counterfactual.
 *
 * Re-runs the whole simulation once per control with that control alone removed. The delta is
 * the only defensible way to price a control here: asking "how much does this reduce risk" in
 * isolation ignores that other controls already cover part of the same loss, and would let the
 * sum of individual control values exceed the total risk being managed.
 *
 * Note the consequence — because overlapping controls cover each other, the values do NOT sum to
 * the difference between inherent and residual, and should not be presented as if they do.
 */
export function valueOfEachControl(
  scenarios: Scenario[],
  holding: ReadonlySet<string>,
  iterations: number,
  seed: number,
): ControlValue[] {
  const baseline = simulate({ scenarios, holding, iterations, seed });
  const controls = [...holding].sort();

  return controls
    .map((controlId) => {
      const without = new Set(holding);
      without.delete(controlId);
      const counterfactual = simulate({ scenarios, holding: without, iterations, seed });

      return {
        controlId,
        withControl: baseline.portfolio.mean,
        withoutControl: counterfactual.portfolio.mean,
        annualValue: counterfactual.portfolio.mean - baseline.portfolio.mean,
        p90WithControl: baseline.portfolio.p90,
        p90WithoutControl: counterfactual.portfolio.p90,
        scenariosAffected: scenarios
          .filter((s) => s.effects.some((e) => e.controlId === controlId))
          .map((s) => s.id),
      };
    })
    .sort((a, b) => b.annualValue - a.annualValue);
}

/**
 * Above this many held controls, exact Shapley is not attempted automatically — 2^15 coalitions
 * is 32,768 full simulation runs, and the caller almost certainly wants sampling instead.
 */
export const EXACT_SHAPLEY_LIMIT = 14;

export interface ShapleyValue {
  readonly controlId: string;
  /** Average marginal contribution across every ordering of the other held controls. */
  readonly shapleyValue: number;
  /** Same figure as a share of total portfolio risk reduction, 0–1. */
  readonly shareOfReduction: number;
}

export interface ShapleyResult {
  readonly method: 'exact' | 'sampled';
  /** Distinct coalitions actually simulated. Exact: 2^n. Sampled: however many distinct prefixes were drawn. */
  readonly coalitionsEvaluated: number;
  /** Permutations drawn. Present only for the sampled method. */
  readonly samples?: number;
  readonly values: ShapleyValue[];
  /** Sum of the values above. Equal to totalReduction by construction — this is the point of using Shapley. */
  readonly totalAllocated: number;
  /** Expected annual loss with nothing held, minus expected annual loss with everything held. */
  readonly totalReduction: number;
}

function popcount(mask: number): number {
  let count = 0;
  let m = mask;
  while (m) {
    m &= m - 1;
    count += 1;
  }
  return count;
}

function emptyShapleyResult(method: 'exact' | 'sampled'): ShapleyResult {
  return { method, coalitionsEvaluated: 0, values: [], totalAllocated: 0, totalReduction: 0 };
}

function finishShapley(
  method: 'exact' | 'sampled',
  coalitionsEvaluated: number,
  totalReduction: number,
  raw: { controlId: string; shapleyValue: number }[],
  samples?: number,
): ShapleyResult {
  const values = raw
    .map((v) => ({
      ...v,
      shareOfReduction: totalReduction !== 0 ? v.shapleyValue / totalReduction : 0,
    }))
    .sort((a, b) => b.shapleyValue - a.shapleyValue);

  return {
    method,
    coalitionsEvaluated,
    ...(samples !== undefined ? { samples } : {}),
    values,
    totalAllocated: raw.reduce((sum, v) => sum + v.shapleyValue, 0),
    totalReduction,
  };
}

/**
 * Exact Shapley value per control: average marginal contribution over every ordering of the
 * others, computed from every one of the 2^n coalitions rather than sampled orderings.
 *
 * This is the fix for the problem `valueOfEachControl` states on its own output: counterfactual
 * values do not sum to the inherent/residual difference, because overlapping controls split
 * credit arbitrarily depending on which one the maths happens to measure last. Shapley's
 * efficiency property guarantees `totalAllocated === totalReduction` — every dollar of measured
 * risk reduction is allocated to exactly one place, split across controls in proportion to their
 * average contribution rather than handed entirely to whichever one is evaluated against the
 * fullest coalition.
 *
 * Cost is 2^n full simulation runs, independent of iteration count. Twelve controls is 4,096 —
 * tractable at a reduced iteration count, which is why this takes its own `iterations` parameter
 * rather than reusing the caller's. Throws above `EXACT_SHAPLEY_LIMIT`; use `shapleyValueSampled`
 * for larger registers.
 */
export function shapleyValueExact(
  scenarios: Scenario[],
  holding: ReadonlySet<string>,
  iterations: number,
  seed: number,
): ShapleyResult {
  const controls = [...holding].sort();
  const n = controls.length;
  if (n === 0) return emptyShapleyResult('exact');
  if (n > EXACT_SHAPLEY_LIMIT) {
    throw new Error(
      `shapleyValueExact: ${n} controls means 2^${n} = ${2 ** n} coalitions, which is not ` +
        `attempted automatically above ${EXACT_SHAPLEY_LIMIT}. Use shapleyValueSampled.`,
    );
  }

  const totalCoalitions = 1 << n;

  // value(mask) = expected annual loss with exactly the controls in `mask` held. Every coalition
  // gets its own full simulation run — this is the expensive part and the reason for a separate,
  // typically-reduced iteration count.
  const lossOf: number[] = new Array(totalCoalitions);
  for (let mask = 0; mask < totalCoalitions; mask += 1) {
    const subset = new Set<string>();
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) subset.add(controls[i]!);
    lossOf[mask] = simulate({ scenarios, holding: subset, iterations, seed }).portfolio.mean;
  }

  const factorial = [1];
  for (let i = 1; i <= n; i += 1) factorial.push(factorial[i - 1]! * i);

  const raw = controls.map((controlId, i) => {
    const bit = 1 << i;
    let phi = 0;
    // Sum over every coalition S that does NOT contain this control, weighted by the fraction of
    // orderings in which S is exactly the set of controls preceding this one.
    for (let mask = 0; mask < totalCoalitions; mask += 1) {
      if (mask & bit) continue;
      const s = popcount(mask);
      const weight = (factorial[s]! * factorial[n - s - 1]!) / factorial[n]!;
      phi += weight * (lossOf[mask]! - lossOf[mask | bit]!);
    }
    return { controlId, shapleyValue: phi };
  });

  const totalReduction = lossOf[0]! - lossOf[totalCoalitions - 1]!;
  return finishShapley('exact', totalCoalitions, totalReduction, raw);
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Shapley value by permutation sampling, for registers too large for `shapleyValueExact`.
 *
 * Draws random orderings of the held controls and, for each, walks the ordering while measuring
 * the loss avoided by adding one more control to the growing coalition. Averaging that
 * contribution across samples converges to the exact Shapley value as samples grows.
 *
 * The efficiency property is not approximate even here: within a single permutation, the
 * contributions along the walk telescope exactly from "nothing held" to "everything held"
 * regardless of order, so the sum across controls equals `totalReduction` on every sample —
 * averaging preserves that sum exactly. What sampling approximates is the *split* between
 * controls, not the total.
 *
 * Ordering is drawn from a generator seeded independently of the one `simulate` consumes
 * internally, so this call remains a pure function of its inputs without perturbing the Monte
 * Carlo streams used to price any individual coalition.
 */
export function shapleyValueSampled(
  scenarios: Scenario[],
  holding: ReadonlySet<string>,
  iterations: number,
  seed: number,
  samples: number,
): ShapleyResult {
  const controls = [...holding].sort();
  const n = controls.length;
  if (n === 0) return emptyShapleyResult('sampled');

  const order = seeded((seed ^ 0x5f3759df) >>> 0);
  const totals = new Map<string, number>(controls.map((c) => [c, 0]));

  // Permutations revisit the same prefixes constantly; cache loss-by-coalition within this call.
  const cache = new Map<string, number>();
  const lossOf = (subset: ReadonlySet<string>): number => {
    const key = [...subset].sort().join(',');
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const value = simulate({ scenarios, holding: subset, iterations, seed }).portfolio.mean;
    cache.set(key, value);
    return value;
  };

  const emptyLoss = lossOf(new Set());
  const fullLoss = lossOf(new Set(controls));

  for (let k = 0; k < samples; k += 1) {
    const permutation = shuffled(controls, order);
    const running = new Set<string>();
    let previousLoss = emptyLoss;
    for (const controlId of permutation) {
      running.add(controlId);
      const nextLoss = lossOf(running);
      totals.set(controlId, totals.get(controlId)! + (previousLoss - nextLoss));
      previousLoss = nextLoss;
    }
  }

  const raw = controls.map((controlId) => ({
    controlId,
    shapleyValue: totals.get(controlId)! / samples,
  }));

  return finishShapley('sampled', cache.size, emptyLoss - fullLoss, raw, samples);
}

/**
 * Shapley value per control, choosing exact computation or permutation sampling automatically
 * based on how many controls are held. Pass `samples` to control the sampled method's precision;
 * ignored when the exact method is used.
 */
export function shapleyValueOfEachControl(
  scenarios: Scenario[],
  holding: ReadonlySet<string>,
  iterations: number,
  seed: number,
  options: { readonly samples?: number } = {},
): ShapleyResult {
  if (holding.size <= EXACT_SHAPLEY_LIMIT) {
    return shapleyValueExact(scenarios, holding, iterations, seed);
  }
  const samples = options.samples ?? Math.max(200, holding.size * 20);
  return shapleyValueSampled(scenarios, holding, iterations, seed, samples);
}
