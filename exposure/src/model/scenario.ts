import type { ThreePoint } from './distributions.js';

/**
 * A loss scenario and the controls that bear on it.
 *
 * The important structural choice: a control's effect on a scenario is itself a three-point
 * estimate, not a percentage. "This gate stops 90% of these" is a number somebody made up; "this
 * gate stops somewhere between 80% and 99% of these, most likely 95%" is a number somebody made
 * up *and admits to*. The second one propagates its own uncertainty into the answer, which is
 * the only honest way to carry a judgment through arithmetic.
 */

export type Dimension = 'frequency' | 'magnitude';

export interface ControlEffect {
  /** The control that must be HELD for this reduction to apply. */
  readonly controlId: string;
  /** Which term it reduces. A gate reduces how often; a filter reduces how much. */
  readonly dimension: Dimension;
  /**
   * Proportional reduction, 0–1. Sampled per iteration, so a control credited at 0.8–0.95–0.99
   * spends some iterations near the pessimistic end.
   */
  readonly reduction: ThreePoint;
  /** Why this figure. Reviewers read this; a number without one is not reviewable. */
  readonly basis: string;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Events per year, before any control. */
  readonly frequency: ThreePoint;
  /** Dollars per event, before any control. */
  readonly magnitude: ThreePoint;
  readonly effects: ControlEffect[];
  /** Where the frequency and magnitude figures came from, honestly stated. */
  readonly estimateBasis: string;
  /**
   * The generic loss type whose published breach-cost reporting this scenario's magnitude
   * substitutes for, or null where no published band describes it.
   *
   * Declared per scenario rather than inferred from the title: which population a figure is
   * standing in for is a judgment, and an inferred mapping would quietly answer a question
   * nobody had asked. Null is a real answer here — half these scenarios are AI-governance
   * failures with no priced analogue anywhere, and reaching for the nearest breach study would
   * be worse than reporting the gap.
   */
  readonly genericLossType?: string | null;
}

export interface ScenarioFile {
  readonly schema: string;
  readonly currency: string;
  readonly iterations: number;
  readonly seed: number;
  readonly scenarios: Scenario[];
}

/**
 * Cap on combined reduction when several controls bear on one scenario.
 *
 * Residual factors are multiplied, which assumes the controls fail independently. They do not:
 * the same attacker, the same deployment mistake, and the same bad afternoon defeat several at
 * once. Multiplying unbounded would let five mediocre controls sum to near-certainty, which is
 * the arithmetic that makes defence-in-depth diagrams look better than they are.
 *
 * The cap is a blunt correction and does not make the independence assumption true. It bounds
 * how wrong it gets. Stated in docs/HONEST-LIMITS.md rather than buried here.
 */
export const MAX_COMBINED_REDUCTION = 0.98;
