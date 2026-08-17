/**
 * Sampling primitives.
 *
 * Everything here is driven by a seeded generator. A Monte Carlo whose answer moves between runs
 * cannot be committed, diffed, or argued with, and every other artefact in this repository is
 * byte-reproducible — a risk number that is not would be the one place a reader has to take
 * something on trust.
 */

/** mulberry32 — small, fast, and good enough for loss aggregation. Not for cryptography. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ThreePoint {
  readonly min: number;
  readonly mode: number;
  readonly max: number;
}

export function validateThreePoint(t: ThreePoint, label: string): void {
  if (!(t.min <= t.mode && t.mode <= t.max)) {
    throw new Error(`${label}: expected min <= mode <= max, got ${t.min}/${t.mode}/${t.max}`);
  }
  if (t.min < 0) throw new Error(`${label}: negative minimum (${t.min})`);
}

/**
 * Triangular sample by inverse transform.
 *
 * Triangular rather than PERT because it makes no claim the three points do not support. A
 * subject-matter estimate of "somewhere between 2 and 40, most likely 8" is three numbers, and a
 * PERT fit would quietly add a confidence parameter nobody supplied.
 */
export function triangular(rand: () => number, t: ThreePoint): number {
  const { min, mode, max } = t;
  if (max === min) return min;
  const u = rand();
  const split = (mode - min) / (max - min);
  return u < split
    ? min + Math.sqrt(u * (max - min) * (mode - min))
    : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/** Standard normal by Box–Muller. Used only as the large-λ Poisson approximation. */
export function normal(rand: () => number): number {
  // Guard against log(0); rand() can return exactly 0.
  const u1 = Math.max(rand(), Number.MIN_VALUE);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Above this rate, Knuth's product loop needs impractically many draws and loses precision. */
export const POISSON_EXACT_LIMIT = 30;

/**
 * Poisson count for a year, given a per-year rate.
 *
 * Knuth's multiplication method below λ=30 — exact, and the natural fit for the tail scenarios
 * that dominate this register. Above it, a normal approximation with continuity correction.
 *
 * The threshold is not cosmetic. An earlier version threw above 30 on the theory that anything
 * that frequent "is not a tail event and the framing needs revisiting". The register promptly
 * disproved it: S-03 is routine identifier disclosure at up to 200 events a year, which is a
 * perfectly coherent scenario whose expected loss is driven by frequency rather than by tail.
 * Refusing to model it would have quietly excluded the most common kind of AI-related loss there
 * is. At λ=30 the Poisson skew is about 0.18 and the approximation is well inside the noise of
 * the three-point estimates feeding it.
 */
export function poisson(rand: () => number, lambda: number): number {
  if (lambda <= 0) return 0;

  if (lambda > POISSON_EXACT_LIMIT) {
    const approx = Math.round(lambda + Math.sqrt(lambda) * normal(rand));
    return Math.max(0, approx);
  }

  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

/** Percentile of a sorted array, by nearest rank. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index]!;
}

export interface Summary {
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  /** Share of simulated years with no loss at all — the number a mean hides. */
  readonly quietYears: number;
}

export function summarise(losses: number[]): Summary {
  const sorted = [...losses].sort((a, b) => a - b);
  const total = sorted.reduce((acc, v) => acc + v, 0);
  return {
    mean: total / (sorted.length || 1),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
    quietYears: sorted.filter((v) => v === 0).length / (sorted.length || 1),
  };
}
