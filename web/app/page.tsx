'use client';

import { useState } from 'react';
import type {
  RunResult,
  EvidenceRecord,
  EvidenceBundle,
  MatrixResult,
  ExposureResult,
} from '@/lib/proofplane-runner';

export default function Page() {
  const [unguarded, setUnguarded] = useState(true);
  const [matrix, setMatrix] = useState(true);
  const [exposure, setExposure] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unguarded, matrix, exposure }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Run failed.');
      setResult(data as RunResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1>proofplane</h1>
      <p className="thesis">
        A control is <b>HELD</b> only when an executed adversarial attack <b>failed</b> — never
        because a document says the control exists. Run it below and watch which controls hold.
      </p>
      <p className="sub">
        <a href="https://rootcawsllc.github.io/proofplane/">Guide</a> ·{' '}
        <a href="https://github.com/RootCawsLLC/proofplane">Source</a> · Attacks run only against a
        deliberately-non-compliant target this app boots on a private local port — never an
        arbitrary or real system.
      </p>

      <div className="callout">
        This runs the <b>real tool</b>, not a recording. It boots the shipped agentic target
        server (twelve toggleable guardrails, a mock model — no API key, no spend), then spawns
        the real Python probe suite to execute twelve adversarial attacks against it. A control is
        credited only when the attack it faces fails in every trial.
      </div>

      <div className="panel">
        <div className="layers">
          <label className="layer">
            <input type="checkbox" checked disabled />
            <span>
              <span className="lt">Guarded assurance run</span>
              <br />
              <span className="ld">12 attacks vs. all guardrails (always on)</span>
            </span>
          </label>
          <label className="layer">
            <input type="checkbox" checked={unguarded} onChange={(e) => setUnguarded(e.target.checked)} />
            <span>
              <span className="lt">Unguarded counterfactual</span>
              <br />
              <span className="ld">same attacks, guardrails removed</span>
            </span>
          </label>
          <label className="layer">
            <input type="checkbox" checked={matrix} onChange={(e) => setMatrix(e.target.checked)} />
            <span>
              <span className="lt">Independence matrix</span>
              <br />
              <span className="ld">12×12, one guardrail off per row</span>
            </span>
          </label>
          <label className="layer">
            <input type="checkbox" checked={exposure} onChange={(e) => setExposure(e.target.checked)} />
            <span>
              <span className="lt">FAIR loss exposure</span>
              <br />
              <span className="ld">priced from the evidence</span>
            </span>
          </label>
        </div>

        <div className="run-row">
          <button className="run" onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run assurance'}
          </button>
          {running && (
            <span className="notes">
              <span className="spinner" /> Booting the target and executing the probe suite — a few
              seconds.
            </span>
          )}
        </div>
      </div>

      {error && <div className="err">{error}</div>}
      {result && <Results result={result} />}
    </>
  );
}

function Results({ result }: { result: RunResult }) {
  const g = result.guarded;
  const held = g.summary.HELD;
  const total = g.records.length;
  const unguardedById = new Map<string, EvidenceRecord>();
  for (const r of result.unguarded?.records ?? []) unguardedById.set(r.control_id, r);

  return (
    <>
      <h2>Guarded assurance report</h2>
      <div className="panel">
        <div className="big-verdict">
          <span className={`n ${held === total ? 'held' : 'breach'}`}>
            {held} / {total}
          </span>
          <span className="lbl">controls HELD — each proven by an attack that failed</span>
        </div>
        <div className="summary">
          <span>model <b>{g.target.model.id}</b> {g.target.model.pinned ? '(pinned)' : '(UNPINNED)'}</span>
          <span><b>{g.target.guardrails.length}</b> guardrails in force</span>
          <span><b>{result.trials}</b> trials per probe</span>
          <span>{(result.durationMs / 1000).toFixed(1)}s</span>
        </div>
        <div className="summary" style={{ marginTop: '0.4rem' }}>
          <span className="mono">evidence head hash {g.head_hash.slice(0, 24)}…</span>
        </div>
      </div>

      {result.operatorNotes.length > 0 && (
        <div className="panel">
          <ul className="notes">
            {result.operatorNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {g.records.map((r) => (
        <ControlCard key={r.control_id} r={r} counterfactual={unguardedById.get(r.control_id) ?? null} />
      ))}

      {result.matrix && <Matrix matrix={result.matrix} />}
      {result.exposure && <Exposure exposure={result.exposure} />}
    </>
  );
}

function outcomeClass(o: string) {
  return o === 'HELD' ? 'held' : o === 'BREACHED' ? 'breach' : 'error';
}

function ControlCard({ r, counterfactual }: { r: EvidenceRecord; counterfactual: EvidenceRecord | null }) {
  const threats = [...r.threat.atlas, ...r.threat.owasp_asi];
  return (
    <div className={`finding ${outcomeClass(r.outcome)}`}>
      <div className="f-head">
        <span className="f-title">{r.control_title}</span>
        <span className="f-cid">{r.control_id}</span>
        <span className={`badge ${outcomeClass(r.outcome)}`}>{r.outcome}</span>
        <span className="f-rate">
          {r.trials.breached}/{r.trials.n} breached
        </span>
      </div>

      <div className="f-attack">
        <span className="k">Attack executed</span>
        {r.attack}
      </div>
      <div className="f-assert">
        <b>Passes when:</b> {r.assertion.passes_when}
      </div>

      {counterfactual && (
        <div className="f-assert">
          <b>Counterfactual</b> — same attack with this guardrail removed:{' '}
          <span className={`badge ${outcomeClass(counterfactual.outcome)}`}>
            {counterfactual.outcome}
          </span>{' '}
          <span className="f-rate">
            {counterfactual.trials.breached}/{counterfactual.trials.n}
          </span>
        </div>
      )}

      {threats.length > 0 && (
        <div className="chips">
          {threats.map((t) => (
            <span className="chip" key={t.id} title={`${t.name} · confidence ${t.confidence}`}>
              {t.id} {t.name}
            </span>
          ))}
        </div>
      )}

      <details className="evidence">
        <summary>Observations — what the probe saw</summary>
        <ul className="obs">
          {r.observations.map((o, i) => (
            <li key={i}>
              <span className="k">{o.label}</span>
              {o.detail}
            </li>
          ))}
        </ul>
      </details>

      {r.crosswalk.length > 0 && (
        <details className="evidence xwalk">
          <summary>Framework crosswalk — mapped, not satisfied ({r.crosswalk.length})</summary>
          <table>
            <tbody>
              {r.crosswalk.map((c, i) => (
                <tr key={i}>
                  <td className="fw">
                    {c.framework} {c.reference}
                    {c.label ? ` (${c.label})` : ''}
                  </td>
                  <td>
                    <span className={`badge conf-${c.confidence}`}>{c.confidence}</span>
                  </td>
                  <td className="basis">{c.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Matrix({ matrix }: { matrix: MatrixResult }) {
  const guardrails = Object.keys(matrix.rows);
  const controls = matrix.controls;
  return (
    <>
      <h2>Independence matrix</h2>
      <div className="panel">
        <p className="f-assert" style={{ marginTop: 0 }}>
          Each row disables one guardrail and re-runs the whole suite. A probe must breach only
          when its <i>own</i> guardrail is removed — breach on the diagonal, held everywhere else.
        </p>
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th className="rowh">disabled ↓ / control →</th>
                {controls.map((c) => (
                  <th key={c}>{c.split('-').pop()}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {guardrails.map((gr) => (
                <tr key={gr}>
                  <th className="rowh">
                    {gr} <span style={{ opacity: 0.6 }}>→ {matrix.expected_breach[gr]?.split('-').pop() ?? '?'}</span>
                  </th>
                  {controls.map((c) => {
                    const o = matrix.rows[gr]?.[c];
                    return (
                      <td key={c} className={o === 'BREACHED' ? 'breach' : 'held'}>
                        {o === 'BREACHED' ? 'BREACH' : 'held'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={`matrix-verdict ${matrix.independent ? 'ok' : 'bad'}`}>
          {matrix.independent
            ? 'Every probe breached exactly when its own guardrail was removed — the controls are independent.'
            : 'An off-diagonal breach was found — a probe is not independent of the other controls.'}
        </p>
      </div>
    </>
  );
}

function money(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function Exposure({ exposure }: { exposure: ExposureResult }) {
  const max = Math.max(...exposure.control_values.map((c) => c.annualValue), 1);
  const sorted = [...exposure.control_values].sort((a, b) => b.annualValue - a.annualValue);
  return (
    <>
      <h2>Loss exposure, bound to control state</h2>
      <div className="panel">
        <div className="exp-grid">
          <div className="exp-fig inherent">
            <div className="v">{money(exposure.inherent.mean)}</div>
            <div className="l">Inherent — nothing credited</div>
            <div className="p">P90 {money(exposure.inherent.p90)} · P99 {money(exposure.inherent.p99)}</div>
          </div>
          <div className="exp-fig residual">
            <div className="v">{money(exposure.residual.mean)}</div>
            <div className="l">Residual — {exposure.evidence.holding.length} controls holding</div>
            <div className="p">P90 {money(exposure.residual.p90)} · P99 {money(exposure.residual.p99)}</div>
          </div>
          <div className="exp-fig diff">
            <div className="v">{money(exposure.difference)}</div>
            <div className="l">
              Difference — {((exposure.difference / exposure.inherent.mean) * 100).toFixed(1)}% of inherent
            </div>
            <div className="p">{exposure.iterations.toLocaleString()} iters · seed {exposure.seed}</div>
          </div>
        </div>
        <p className="f-assert" style={{ marginTop: 0 }}>
          What each control is worth per year, by counterfactual (these do not sum):
        </p>
        {sorted.map((c) => (
          <div className="cv" key={c.controlId}>
            <span className="cid">{c.controlId}</span>
            <span className="bar" style={{ width: `${(c.annualValue / max) * 60}%` }} />
            <span className="amt">{money(c.annualValue)}</span>
          </div>
        ))}
        <p className="notes" style={{ marginTop: '0.75rem', listStyle: 'none', paddingLeft: 0 }}>
          {exposure.caveat}
        </p>
      </div>
    </>
  );
}
