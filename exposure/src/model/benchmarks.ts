/**
 * Published loss bands for the generic loss types this model substitutes for.
 *
 * scenarios.json states, in its own `_note`, that frequency and magnitude are anchored on generic
 * breach-cost reporting rather than AI-specific incident data, and calls that substitution its
 * single largest weakness. That is an honest sentence, and until now an uncheckable one: no
 * publication was named. These bands name them.
 *
 * They are NOT the source of any figure in scenarios.json and must never be presented as if they
 * were. They are the yardstick a reviewer holds against it.
 *
 * Only magnitude is carried across. A per-firm annual breach rate and a per-workflow agent event
 * rate are different quantities, and putting them in the same column would invite exactly the
 * comparison the data cannot support.
 */

import { existsSync, readFileSync } from 'node:fs';

export interface BenchmarkSource {
  readonly parameter: string;
  readonly name: string | null;
  readonly url: string | null;
  readonly confidence: string | null;
  readonly limitation: string | null;
}

export interface BenchmarkLossType {
  readonly lossType: string;
  readonly benchmarkId: string;
  readonly label: string;
  /** Why this published population is the nearest analogue to the modelled loss. */
  readonly why: string;
  readonly currency: string;
  readonly magnitude: { readonly min: number; readonly likely: number; readonly max: number };
  readonly provenanceTier: string;
  readonly confidence: Record<string, number>;
  readonly notGoodFor: string | null;
  readonly sources: BenchmarkSource[];
}

export interface BenchmarkFile {
  readonly schema: string;
  readonly source: {
    readonly corpus: string;
    readonly upstream: string;
    readonly upstreamCommit: string;
    readonly license: string;
    readonly retrieved: string;
  };
  readonly lossTypes: BenchmarkLossType[];
}

/** Where a scenario's own magnitude sits against the published band for its loss type. */
export type BandPosition =
  | 'below the published floor'
  | 'between the floor and the central estimate'
  | 'between the central estimate and the ceiling'
  | 'above the published ceiling';

export function positionInBand(value: number, band: BenchmarkLossType['magnitude']): BandPosition {
  if (value < band.min) return 'below the published floor';
  if (value < band.likely) return 'between the floor and the central estimate';
  if (value < band.max) return 'between the central estimate and the ceiling';
  return 'above the published ceiling';
}

/**
 * Read the vendored bands, or null if the file is absent.
 *
 * Absent is not an error. The exposure figures do not depend on these, so a missing yardstick
 * drops the cross-check section rather than failing a run that is otherwise complete.
 */
export function loadBenchmarks(path: string): BenchmarkFile | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as BenchmarkFile;
}

export function lossTypeFor(
  file: BenchmarkFile | null,
  lossType: string | null | undefined,
): BenchmarkLossType | null {
  if (!file || !lossType) return null;
  return file.lossTypes.find((t) => t.lossType === lossType) ?? null;
}
