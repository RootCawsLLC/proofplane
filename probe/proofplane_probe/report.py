"""Render an evidence bundle as a self-contained HTML report.

Design constraint: a reader must be able to get from "this control is satisfied" to "here is the
attack that was executed and what it did" without leaving the page. A status badge with no path
back to the executed test is the artefact this project exists to argue against.
"""

from __future__ import annotations

import html
from typing import Any

CSS = """
:root{
  --bg:#FAFAF8;--panel:#FFFFFF;--panel-2:#F5F1E8;--border:#e0e0e0;
  --ink:#1a1a1a;--ink-2:#444444;--ink-3:#666666;
  --accent:#6B63B5;--accent-soft:#efedf9;
  --breach:#B4413F;--breach-bg:#fbeceb;
  --held:#2F7D53;--held-bg:#e9f5ee;
  --err:#8a6d1f;--err-bg:#f8f1dd;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#1a1a1a;--panel:#242424;--panel-2:#2d2d2d;--border:#333333;
    --ink:#f0f0f0;--ink-2:#c0c0c0;--ink-3:#999999;
    --accent:#8B7FD6;--accent-soft:#2b2740;
    --breach:#E58A88;--breach-bg:#3a2422;
    --held:#7FC79B;--held-bg:#1f3229;
    --err:#D9BE72;--err-bg:#332c19;
  }
}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem 4rem;background:var(--bg);color:var(--ink);
  font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:60rem;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .25rem;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:0 0 .5rem}
.sub{color:var(--ink-3);margin:0 0 1.5rem;font-size:.9rem}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.75rem;
  background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:1rem;margin-bottom:1.25rem}
.meta div{min-width:0}
.meta dt{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);margin-bottom:.15rem}
.meta dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;
  word-break:break-all;color:var(--ink-2)}
.tally{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1.5rem}
.pill{padding:.3rem .7rem;border-radius:999px;font-size:.8rem;font-weight:600;border:1px solid transparent}
.pill.breach{background:var(--breach-bg);color:var(--breach);border-color:var(--breach)}
.pill.held{background:var(--held-bg);color:var(--held);border-color:var(--held)}
.pill.err{background:var(--err-bg);color:var(--err);border-color:var(--err)}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;
  padding:1.1rem 1.25rem;margin-bottom:1rem;border-left:4px solid var(--border)}
.card.breach{border-left-color:var(--breach)}
.card.held{border-left-color:var(--held)}
.card.err{border-left-color:var(--err)}
.card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap}
.cid{font-family:ui-monospace,monospace;font-size:.78rem;color:var(--ink-3)}
.rate{font-family:ui-monospace,monospace;font-size:.78rem;color:var(--ink-3);white-space:nowrap}
.attack{background:var(--panel-2);border-radius:6px;padding:.6rem .8rem;margin:.75rem 0;
  font-size:.88rem;color:var(--ink-2)}
.attack b{color:var(--ink);font-weight:600}
.chips{display:flex;gap:.35rem;flex-wrap:wrap;margin:.6rem 0}
.chip{font-family:ui-monospace,monospace;font-size:.72rem;padding:.15rem .5rem;border-radius:4px;
  background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent)}
details{margin-top:.6rem}
summary{cursor:pointer;font-size:.85rem;color:var(--accent);font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:.6rem;font-size:.8rem}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--ink-3);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
td.basis{color:var(--ink-3);font-size:.76rem}
.conf{font-family:ui-monospace,monospace;font-size:.72rem}
.conf-high{color:var(--held)}.conf-medium{color:var(--err)}.conf-low{color:var(--ink-3)}
ul.obs{margin:.5rem 0 0;padding-left:1.1rem}
ul.obs li{margin-bottom:.3rem;font-size:.84rem;color:var(--ink-2)}
ul.obs code{font-family:ui-monospace,monospace;font-size:.8rem;color:var(--ink)}
.scroll{overflow-x:auto}
footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--border);
  color:var(--ink-3);font-size:.8rem}
"""

_CLASS = {"BREACHED": "breach", "HELD": "held", "ERROR": "err"}


def _e(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _ci(trials: dict[str, Any]) -> str:
    """Show the interval only where it means something — see runner.wilson_interval."""
    if not trials.get("ci_meaningful"):
        return ""
    lo, hi = trials.get("rate_ci95", [0, 1])
    return (
        f'<div class="rate" title="95% Wilson score interval for the true breach rate">'
        f"true rate 95% CI {lo:.0%}–{hi:.0%}</div>"
    )


def _card(record: dict[str, Any]) -> str:
    cls = _CLASS.get(record["outcome"], "err")
    trials = record.get("trials", {})
    threat = record.get("threat", {})

    chips = "".join(
        f'<span class="chip">{_e(t["id"])}</span>'
        for t in list(threat.get("atlas", [])) + list(threat.get("owasp_asi", []))
    )

    obs = "".join(
        f'<li><code>{_e(o["label"])}</code> — {_e(o["detail"])}</li>'
        for o in record.get("observations", [])
    )

    rows = "".join(
        f"<tr><td>{_e(m['framework'])}</td>"
        f"<td><code>{_e(m['reference'])}</code>{(' — ' + _e(m['label'])) if m.get('label') else ''}</td>"
        f"<td class=\"conf conf-{_e(m['confidence'])}\">{_e(m['confidence'])}</td>"
        f"<td class=\"basis\">{_e(m['basis'])}</td></tr>"
        for m in record.get("crosswalk", [])
    )

    verdict = (
        "attack succeeded" if record["outcome"] == "BREACHED"
        else "attack failed in every trial" if record["outcome"] == "HELD"
        else "could not be assessed"
    )

    return f"""
<article class="card {cls}">
  <div class="card-head">
    <div>
      <h2>{_e(record["control_title"])}</h2>
      <div class="cid">{_e(record["control_id"])} &middot; proved by {_e(record["probe_id"])}</div>
    </div>
    <div style="text-align:right">
      <span class="pill {cls}">{_e(record["outcome"])}</span>
      <div class="rate">{_e(trials.get("breached", 0))}/{_e(trials.get("n", 0))} trials breached</div>
      {_ci(trials)}
    </div>
  </div>
  <div class="attack"><b>Attack executed:</b> {_e(record["attack"])}<br><b>Result:</b> {verdict}.</div>
  <div class="chips">{chips}</div>
  <details open>
    <summary>What the probe observed</summary>
    <ul class="obs">{obs}</ul>
  </details>
  <details>
    <summary>Framework crosswalk ({len(record.get("crosswalk", []))} mappings)</summary>
    <div class="scroll"><table>
      <thead><tr><th>Framework</th><th>Reference</th><th>Confidence</th><th>Basis</th></tr></thead>
      <tbody>{rows}</tbody>
    </table></div>
  </details>
  <details>
    <summary>Evidence hash</summary>
    <ul class="obs">
      <li><code>sha256</code> — {_e(record.get("hash", ""))}</li>
      <li><code>prev</code> — {_e(record.get("prev_hash", ""))}</li>
    </ul>
  </details>
</article>"""


def _matrix(matrix: dict[str, Any] | None) -> str:
    if not matrix:
        return ""

    controls = matrix.get("controls", [])
    rows = matrix.get("rows", {})
    expected = matrix.get("expected_breach", {})

    head = "".join(f"<th>{_e(c.split('-')[-1])}</th>" for c in controls)
    body = ""
    for guardrail in matrix.get("guardrails", []):
        cells = ""
        for control in controls:
            outcome = rows.get(guardrail, {}).get(control, "?")
            on_diagonal = expected.get(guardrail) == control
            cls = "breach" if outcome == "BREACHED" else "held" if outcome == "HELD" else "err"
            mark = "breach" if outcome == "BREACHED" else "held" if outcome == "HELD" else "?"
            weight = "font-weight:700" if on_diagonal else "opacity:.55"
            cells += f'<td class="conf conf-{cls}" style="{weight}">{mark}</td>'
        body += f"<tr><th><code>{_e(guardrail)}</code> off</th>{cells}</tr>"

    verdict = (
        "Every probe breached when — and only when — its own guardrail was removed."
        if matrix.get("independent")
        else "At least one probe responded to a guardrail other than its own. Results below are not trustworthy."
    )

    return f"""
<article class="card {'held' if matrix.get('independent') else 'breach'}">
  <div class="card-head"><div>
    <h2>Independence matrix</h2>
    <div class="cid">one guardrail disabled per row &middot; whole suite run against each configuration</div>
  </div></div>
  <div class="attack">
    Falsifiability shows a probe reacts to the absence of its control. It does not show the probe
    reacts to <b>nothing else</b>. Without that, a probe could be passing because an unrelated
    guardrail masks the attack. <b>{verdict}</b>
  </div>
  <div class="scroll"><table>
    <thead><tr><th></th>{head}</tr></thead>
    <tbody>{body}</tbody>
  </table></div>
</article>"""


def render(bundle: dict[str, Any], matrix: dict[str, Any] | None = None) -> str:
    target = bundle.get("target", {})
    model = target.get("model", {})
    summary = bundle.get("summary", {})
    guardrails = ", ".join(target.get("guardrails", [])) or "none"

    tally = "".join(
        f'<span class="pill {_CLASS[k]}">{summary.get(k, 0)} {k.lower()}</span>'
        for k in ("BREACHED", "HELD", "ERROR")
        if summary.get(k)
    )

    cards = "".join(_card(r) for r in bundle.get("records", []))

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>proofplane assurance run {_e(bundle.get("run_id", ""))}</title>
<style>{CSS}</style></head>
<body><div class="wrap">
<h1>Continuous assurance run</h1>
<p class="sub">Every status below is the outcome of an attack that was executed against a running
system. Nothing here was asserted.</p>

<dl class="meta">
  <div><dt>Run</dt><dd>{_e(bundle.get("run_id", ""))}</dd></div>
  <div><dt>Recorded</dt><dd>{_e(bundle.get("recorded_at", ""))}</dd></div>
  <div><dt>Target</dt><dd>{_e(target.get("base_url", ""))}</dd></div>
  <div><dt>Serving model</dt><dd>{_e(model.get("provider", "?"))}:{_e(model.get("id", "?"))}
    {"(pinned)" if model.get("pinned") else "(UNPINNED)"}</dd></div>
  <div><dt>Guardrails in force</dt><dd>{_e(guardrails)}</dd></div>
  <div><dt>Evidence head</dt><dd>{_e(bundle.get("head_hash", ""))[:32]}…</dd></div>
</dl>

<div class="tally">{tally}</div>
{_matrix(matrix)}
{cards}

<footer>
Generated by proofplane-probe. A control is reported satisfied only when the attack failed in
every trial; the trial count is shown because "did not breach in n attempts" is a weaker claim
than "cannot breach", and the difference matters.
</footer>
</div></body></html>
"""
