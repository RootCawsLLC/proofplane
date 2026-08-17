import { createHash } from 'node:crypto';

/**
 * Guardrail G5 — tamper-evident interaction log (control PP-C005).
 *
 * Each entry commits to the hash of its predecessor, so removing or editing an entry breaks
 * every hash after it. This is tamper-EVIDENT, not tamper-PROOF: an actor who can rewrite the
 * whole store can recompute the chain. Real assurance requires anchoring the head hash
 * somewhere that actor does not control. We do not do that, and docs/HONEST-LIMITS.md says so.
 */

export interface AuditEntry {
  readonly seq: number;
  readonly ts: string;
  readonly event: string;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly hash: string;
}

const GENESIS = '0'.repeat(64);

/** Stable stringify so the hash does not depend on key insertion order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function digest(parts: {
  seq: number;
  ts: string;
  event: string;
  payload: unknown;
  prevHash: string;
}): string {
  return createHash('sha256').update(canonical(parts)).digest('hex');
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  /** Set when G5 is off. Nothing is recorded and verification reports the absence honestly. */
  constructor(private readonly recording: boolean) {}

  append(event: string, payload: unknown): AuditEntry | null {
    if (!this.recording) return null;
    const seq = this.entries.length + 1;
    const prevHash = this.entries.at(-1)?.hash ?? GENESIS;
    // Counter-derived timestamp, not wall clock: evidence must be byte-reproducible.
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 1000).toISOString();
    const hash = digest({ seq, ts, event, payload, prevHash });
    const entry: AuditEntry = { seq, ts, event, payload, prevHash, hash };
    this.entries.push(entry);
    return entry;
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  /**
   * Recompute the chain from genesis. Returns the first sequence number at which the stored
   * hash disagrees with the recomputed one, or null if the chain is intact.
   */
  verify(): { intact: boolean; brokenAt: number | null; length: number } {
    let prevHash = GENESIS;
    for (const e of this.entries) {
      const expected = digest({ seq: e.seq, ts: e.ts, event: e.event, payload: e.payload, prevHash });
      if (expected !== e.hash || e.prevHash !== prevHash) {
        return { intact: false, brokenAt: e.seq, length: this.entries.length };
      }
      prevHash = e.hash;
    }
    return { intact: true, brokenAt: null, length: this.entries.length };
  }

  /**
   * Test affordance used by probe PP-P005 to demonstrate that the chain actually detects
   * modification. Exposed over HTTP only when the target runs with PROOFPLANE_ALLOW_TAMPER=1.
   */
  tamper(seq: number, newEvent: string): boolean {
    const idx = this.entries.findIndex((e) => e.seq === seq);
    if (idx === -1) return false;
    const current = this.entries[idx]!;
    // Rewrite the payload but leave the stored hash alone — exactly what an editor would do.
    this.entries[idx] = { ...current, event: newEvent };
    return true;
  }

  reset(): void {
    this.entries = [];
  }
}
