import type { BoundState } from './bind.js';
import type { BenchmarkFile } from './model/benchmarks.js';
import { lossTypeFor, positionInBand } from './model/benchmarks.js';
import type { Scenario } from './model/scenario.js';
import type { ControlValue, ShapleyResult, SimulationResult } from './model/simulate.js';

const CSS = `
:root{
  --bg:#FAFAF8;--panel:#FFFFFF;--panel-2:#F5F1E8;--border:#e0e0e0;
  --ink:#1a1a1a;--ink-2:#444444;--ink-3:#666666;
  --accent:#6B63B5;--accent-soft:#efedf9;
  --breach:#B4413F;--breach-bg:#fbeceb;--held:#2F7D53;--held-bg:#e9f5ee;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#1a1a1a;--panel:#242424;--panel-2:#2d2d2d;--border:#333333;
    --ink:#f0f0f0;--ink-2:#c0c0c0;--ink-3:#999999;
    --accent:#8B7FD6;--accent-soft:#2b2740;
    --breach:#E58A88;--breach-bg:#3a2422;--held:#7FC79B;--held-bg:#1f3229;
  }
}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem 4rem;background:var(--bg);color:var(--ink);
  font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:62rem;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .3rem;letter-spacing:-.01em}
.sub{color:var(--ink-3);margin:0 0 1.5rem;font-size:.9rem}
h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-3);
  margin:2rem 0 .7rem;font-weight:600}
.headline{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:.75rem;margin-bottom:1rem}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:1rem 1.1rem}
.stat .k{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.stat .v{font-size:1.45rem;font-weight:600;margin-top:.2rem;letter-spacing:-.02em}
.stat .n{font-size:.78rem;color:var(--ink-3);margin-top:.15rem}
.stat.good .v{color:var(--held)}
.stat.bad .v{color:var(--breach)}
.meta{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:.85rem 1.05rem;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;color:var(--ink-2);
  margin-bottom:1rem;word-break:break-all}
.note{background:var(--panel-2);border-radius:8px;padding:.85rem 1.05rem;font-size:.88rem;
  color:var(--ink-2);margin:1rem 0}
.note b{color:var(--ink)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.85rem;background:var(--panel);
  border:1px solid var(--border);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--ink-3);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
td.num{text-align:right;font-family:ui-monospace,monospace;white-space:nowrap}
td code{white-space:nowrap}
tbody tr td:first-child{white-space:nowrap}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.7rem;font-weight:600;
  border:1px solid transparent}
.pill.held{background:var(--held-bg);color:var(--held);border-color:var(--held)}
.pill.breach{background:var(--breach-bg);color:var(--breach);border-color:var(--breach)}
.bar{height:.5rem;background:var(--accent-soft);border-radius:3px;overflow:hidden;min-width:4rem}
.bar span{display:block;height:100%;background:var(--accent)}
footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--border);
  color:var(--ink-3);font-size:.82rem}
footer a{color:var(--accent)}
`;

function esc(v: unknown): string {
  return String(v).replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
}

function money(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export interface ReportInput {
  readonly state: BoundState;
  readonly inherent: SimulationResult;
  readonly residual: SimulationResult;
  readonly controlValues: ControlValue[];
  readonly shapley?: ShapleyResult;
  readonly iterations: number;
  readonly currency: string;
  /** Scenario definitions, for the declared generic loss type on each. */
  readonly scenarios?: Scenario[];
  /** Published bands for those loss types. Omitted, the cross-check section is not rendered. */
  readonly benchmarks?: BenchmarkFile | null;
}

/**
 * The section that makes `scenarios.json`'s own admission checkable.
 *
 * It compares magnitude only, and it reports the scenarios with no published analogue as loudly
 * as the ones that have one — four of eight here. A cross-check that silently dropped the
 * unmatched rows would read as full coverage.
 */
function crossCheckSection(
  scenarios: Scenario[] | undefined,
  benchmarks: BenchmarkFile | null | undefined,
): string {
  if (!scenarios?.length || !benchmarks) return '';

  const rows = scenarios
    .map((s) => {
      const band = lossTypeFor(benchmarks, s.genericLossType);
      if (!band) {
        return `<tr>
        <td><code>${esc(s.id)}</code></td>
        <td>${esc(s.title)}</td>
        <td colspan="3"><span class="pill breach">no published band</span> nothing prices this loss type</td>
      </tr>`;
      }
      return `<tr>
        <td><code>${esc(s.id)}</code></td>
        <td>${esc(s.title)}</td>
        <td class="num">${money(s.magnitude.mode)}</td>
        <td class="num">${money(band.magnitude.min)} → ${money(band.magnitude.likely)} → ${money(band.magnitude.max)}</td>
        <td>${esc(positionInBand(s.magnitude.mode, band.magnitude))}</td>
      </tr>`;
    })
    .join('');

  const matched = scenarios.filter((s) => lossTypeFor(benchmarks, s.genericLossType)).length;

  const bandNotes = benchmarks.lossTypes
    .map(
      (t) => `<li><b>${esc(t.lossType)}</b> — ${esc(t.label)} (${esc(t.currency)},
        ${esc(t.provenanceTier.replace(/_/g, ' '))},
        ${Object.entries(t.confidence)
          .map(([k, n]) => `${n} ${esc(k)}`)
          .join(', ')} confidence). ${esc(t.why)}
        ${t.notGoodFor ? `<br><i>Not good for:</i> ${esc(t.notGoodFor)}` : ''}
        <br>${t.sources
          .map(
            (src) =>
              `<code>${esc(src.parameter)}</code> ${
                src.url
                  ? `<a href="${esc(src.url)}">${esc(src.name)}</a>`
                  : esc(src.name ?? 'unattributed')
              }`,
          )
          .join(' &middot; ')}</li>`,
    )
    .join('');

  return `<h2>Generic-loss-type cross-check</h2>
<div class="note">
  <code>scenarios.json</code> says its magnitudes are anchored on generic breach-cost reporting
  rather than AI-specific incident data. This is that claim, checkable. <b>These bands are not the
  source of any figure above</b> — they are a published yardstick held against it, and where a
  scenario sits outside one that is a question to answer, not an error.
  <b>${matched} of ${scenarios.length} scenarios have a published analogue at all.</b>
  The rest are AI-governance failures nobody prices, which is the substitution problem stated as a
  count rather than a sentence. Magnitude only: a per-firm annual breach rate and a per-workflow
  agent event rate are different quantities, so frequency is deliberately not compared.
</div>
<div class="scroll"><table>
  <thead><tr>
    <th>ID</th><th>Scenario</th><th class="num">Modeled magnitude (mode)</th>
    <th class="num">Published band (min → central → max)</th><th>Position</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<div class="note">
  <b>The bands, and what limits them.</b>
  <ul>${bandNotes}</ul>
  Vendored from <a href="${esc(benchmarks.source.corpus)}">risk-benchmarks</a> at
  <code>${esc(benchmarks.source.upstreamCommit.slice(0, 7))}</code>, retrieved
  ${esc(benchmarks.source.retrieved)}, ${esc(benchmarks.source.license)}. Copied into this repo
  rather than fetched: this report is hash-chained evidence regenerated nightly, and a build that
  reached the network for these figures would make a reproducible artefact depend on a
  third-party site staying up.
</div>
`;
}

export function render(input: ReportInput): string {
  const { state, inherent, residual, controlValues, shapley, iterations } = input;
  const reduction = inherent.portfolio.mean - residual.portfolio.mean;
  const reductionPct = inherent.portfolio.mean > 0 ? reduction / inherent.portfolio.mean : 0;
  const maxValue = Math.max(...controlValues.map((c) => c.annualValue), 1);

  const scenarioRows = residual.scenarios
    .map((r, i) => {
      const inh = inherent.scenarios[i]!;
      return `<tr>
        <td><code>${esc(r.id)}</code></td>
        <td>${esc(r.title)}</td>
        <td class="num">${money(inh.summary.mean)}</td>
        <td class="num">${money(r.summary.mean)}</td>
        <td class="num">${money(r.summary.p90)}</td>
        <td>${r.appliedControls.map((c) => `<span class="pill held">${esc(c)}</span>`).join(' ') || '<span class="pill breach">none holding</span>'}</td>
      </tr>`;
    })
    .join('');

  const valueRows = controlValues
    .map(
      (c) => `<tr>
        <td><code>${esc(c.controlId)}</code></td>
        <td class="num">${money(c.annualValue)}</td>
        <td><div class="bar"><span style="width:${((c.annualValue / maxValue) * 100).toFixed(1)}%"></span></div></td>
        <td class="num">${money(c.p90WithControl)} → ${money(c.p90WithoutControl)}</td>
        <td>${c.scenariosAffected.map((s) => `<code>${esc(s)}</code>`).join(', ')}</td>
      </tr>`,
    )
    .join('');

  const shapleyRows = shapley
    ? shapley.values
        .map(
          (v) => `<tr>
        <td><code>${esc(v.controlId)}</code></td>
        <td class="num">${money(v.shapleyValue)}</td>
        <td>${(v.shareOfReduction * 100).toFixed(1)}%</td>
      </tr>`,
        )
        .join('')
    : '';

  const shapleySection = shapley
    ? `<h2>Shapley value per control</h2>
<div class="note">
  Average marginal contribution across every ordering of the other held controls
  (${esc(shapley.method)}, ${shapley.coalitionsEvaluated.toLocaleString()} coalitions${
    shapley.samples ? `, ${shapley.samples.toLocaleString()} permutation samples` : ''
  }).
  Unlike the counterfactual table above, <b>these sum to the inherent/residual difference by
  construction</b> — ${money(shapley.totalAllocated)} allocated against a
  ${money(shapley.totalReduction)} difference. Overlapping controls still split credit unevenly
  where their effectiveness estimates differ, but no dollar of measured reduction goes
  unattributed or double-counted.
</div>
<div class="scroll"><table>
  <thead><tr><th>Control</th><th class="num">Shapley value</th><th>Share of reduction</th></tr></thead>
  <tbody>${shapleyRows}</tbody>
</table></div>
`
    : '';

  const breachedNote =
    state.breached.length > 0
      ? `<div class="note"><b>${state.breached.length} control(s) are not holding:</b>
         ${state.breached.map((c) => `<code>${esc(c)}</code>`).join(', ')}.
         Their mitigation has been removed from the model, which is why residual exposure is
         where it is.</div>`
      : `<div class="note"><b>Every priced control is currently holding.</b> Residual exposure
         below assumes all of them work as credited. The moment one breaches, its credit is
         dropped on the next run and these figures move.</div>`;

  const scopeNote = state.evidenceFromLiveModel
    ? `Evidence came from a live model (${esc(state.model.id ?? 'unknown')}). Read the trial
       counts in the assurance report before treating any control as reliably holding.`
    : `Evidence came from the <b>deterministic model double</b>, not a language model. Every
       figure here is therefore a statement about the guardrails, <b>not</b> about a deployed
       system's safety. The dollar amounts inherit the scope of the evidence beneath them.`;

  const unassessed =
    state.unassessed.length > 0
      ? `<div class="note"><b>Priced but never assessed:</b>
         ${state.unassessed.map((c) => `<code>${esc(c)}</code>`).join(', ')}. These controls
         appear in the register and no probe reported on them, so they receive no credit.</div>`
      : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>proofplane — loss exposure bound to control state</title>
<style>${CSS}</style></head>
<body><div class="wrap">

<h1>Loss exposure</h1>
<p class="sub">Annualised, in ${esc(input.currency)}. A control is credited only when a probe
executed an attack against it and the attack failed.</p>

<div class="meta">
run ${esc(state.runId)} &middot; recorded ${esc(state.recordedAt)} &middot;
model ${esc(state.model.provider ?? '?')}:${esc(state.model.id ?? '?')}${state.model.pinned ? ' (pinned)' : ' (UNPINNED)'}<br>
evidence head ${esc(state.headHash)}<br>
${iterations.toLocaleString()} iterations &middot; ${esc(state.holding.size)} controls holding,
${esc(state.breached.length)} breached
</div>

<div class="headline">
  <div class="stat bad">
    <div class="k">Inherent — no controls</div>
    <div class="v">${money(inherent.portfolio.mean)}</div>
    <div class="n">expected annual loss &middot; P90 ${money(inherent.portfolio.p90)}</div>
  </div>
  <div class="stat good">
    <div class="k">Residual — controls that held</div>
    <div class="v">${money(residual.portfolio.mean)}</div>
    <div class="n">expected annual loss &middot; P90 ${money(residual.portfolio.p90)}</div>
  </div>
  <div class="stat">
    <div class="k">Difference</div>
    <div class="v">${money(reduction)}</div>
    <div class="n">${(reductionPct * 100).toFixed(1)}% of inherent &middot; what the evidence buys</div>
  </div>
  <div class="stat">
    <div class="k">Quiet years</div>
    <div class="v">${(residual.portfolio.quietYears * 100).toFixed(0)}%</div>
    <div class="n">simulated years with no loss at all</div>
  </div>
</div>

${breachedNote}
${unassessed}

<h2>By scenario</h2>
<div class="scroll"><table>
  <thead><tr>
    <th>ID</th><th>Scenario</th><th class="num">Inherent (mean)</th>
    <th class="num">Residual (mean)</th><th class="num">Residual P90</th><th>Credited controls</th>
  </tr></thead>
  <tbody>${scenarioRows}</tbody>
</table></div>

<h2>What each control is worth</h2>
<div class="note">
  Computed by counterfactual: the whole simulation re-run once per control with that control
  alone removed. <b>These do not sum to the difference above</b>, and should never be presented
  as if they do — overlapping controls cover part of the same loss, so summing them would
  double-count. A control worth little here may be worth a great deal once the control
  overlapping it stops holding.
</div>
<div class="scroll"><table>
  <thead><tr>
    <th>Control</th><th class="num">Annual value</th><th>Relative</th>
    <th class="num">P90 with → without</th><th>Scenarios</th>
  </tr></thead>
  <tbody>${valueRows}</tbody>
</table></div>

${shapleySection}
${crossCheckSection(input.scenarios, input.benchmarks)}
<div class="note"><b>Scope.</b> ${scopeNote}</div>

<div class="note">
  <b>The weakest input is control effectiveness.</b> Every reduction figure in
  <code>scenarios.json</code> is a judgment, carried as a three-point estimate so its uncertainty
  reaches the answer rather than being hidden by a tidy percentage. Frequency and magnitude are
  anchored on generic breach-cost reporting, not AI-specific incident data, because that data is
  thin and mostly unpublished. Replace all of it with calibrated estimates before any figure here
  means anything about your organization.
</div>

<footer>
Generated by proofplane-exposure. Method, assumptions and what breaks them:
<a href="https://github.com/RootCawsLLC/proofplane/blob/main/docs/HONEST-LIMITS.md">HONEST-LIMITS.md</a>
&middot; <a href="https://github.com/RootCawsLLC/proofplane">source</a>
</footer>

</div></body></html>
`;
}
