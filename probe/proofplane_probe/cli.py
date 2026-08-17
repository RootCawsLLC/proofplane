"""proofplane-probe command line.

    run      execute the probe suite against one target and write evidence
    verify   run against an unguarded AND a guarded target, and fail if any probe is not
             falsifiable — this is the suite's own test suite
    report   render an evidence bundle as HTML
    catalog  print the control catalog and its crosswalk coverage
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dataclasses import asdict

from .catalog import load_catalog
from .corroborate import corroborate
from .evidence import load_bundle, resolve_timestamp
from .limits import ESCALATED, run_demonstrations
from .oscal import to_assessment_results
from .report import render
from .runner import check_falsifiability, check_independence, run_matrix, run_suite
from .target import Target, TargetError

DEFAULT_CATALOG = Path(__file__).resolve().parents[2] / "catalog"


def _catalog_path(raw: str | None) -> Path:
    return Path(raw).resolve() if raw else DEFAULT_CATALOG


def cmd_run(args: argparse.Namespace) -> int:
    catalog = load_catalog(_catalog_path(args.catalog))
    target = Target(args.target)
    recorded_at = resolve_timestamp(args.run_timestamp)

    bundle = run_suite(
        target,
        catalog,
        run_id=args.run_id,
        recorded_at=recorded_at,
        trials=args.trials,
        only=args.only or None,
    )

    out_dir = Path(args.out)
    bundle.write(out_dir / "evidence.json")

    oscal_path = out_dir / "oscal-assessment-results.json"
    oscal_path.write_text(
        json.dumps(to_assessment_results(bundle), indent=2) + "\n", encoding="utf-8"
    )

    summary = bundle.summary()
    guardrails = ", ".join(bundle.target.get("guardrails", [])) or "none"
    print(f"target      {target.base_url}")
    print(f"guardrails  {guardrails}")
    print(f"model       {bundle.target.get('model', {}).get('id', '?')}")
    print(f"trials      {args.trials} per probe")
    print()
    for record in bundle.records:
        mark = "BREACHED" if record.outcome == "BREACHED" else record.outcome
        rate = f"{record.trials['breached']}/{record.trials['n']}"
        print(f"  {record.control_id}  {mark:<9} {rate:>5}  {record.control_title}")
    print()
    print(f"summary     {summary['BREACHED']} breached, {summary['HELD']} held, "
          f"{summary['ERROR']} error")
    print(f"evidence    {out_dir / 'evidence.json'}")
    print(f"oscal       {oscal_path}")
    print(f"head hash   {bundle.head_hash}")

    if args.fail_on_breach and summary["BREACHED"]:
        return 1
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    """Prove the probes can fail.

    A suite that reports green against a system with every guardrail switched off is measuring
    nothing. This command is the reason anyone should believe the other command's output.
    """
    catalog = load_catalog(_catalog_path(args.catalog))
    recorded_at = resolve_timestamp(args.run_timestamp)

    print("falsifiability check")
    print(f"  unguarded target  {args.vulnerable}")
    print(f"  guarded target    {args.hardened}")
    print()

    vulnerable = run_suite(
        Target(args.vulnerable), catalog,
        run_id=f"{args.run_id}-vulnerable", recorded_at=recorded_at, trials=args.trials,
    )
    hardened = run_suite(
        Target(args.hardened), catalog,
        run_id=f"{args.run_id}-hardened", recorded_at=recorded_at, trials=args.trials,
    )

    if vulnerable.target.get("guardrails"):
        print(f"  WARNING: --vulnerable target reports guardrails "
              f"{vulnerable.target['guardrails']}; expected none", file=sys.stderr)

    by_id = {r.probe_id: r for r in hardened.records}
    for record in vulnerable.records:
        counterpart = by_id.get(record.probe_id)
        h = counterpart.outcome if counterpart else "MISSING"
        ok = record.outcome == "BREACHED" and h == "HELD"
        print(f"  {'ok  ' if ok else 'FAIL'}  {record.control_id}  "
              f"unguarded={record.outcome:<9} guarded={h:<9} {record.control_title}")

    failures = check_falsifiability(vulnerable, hardened)
    print()

    if args.out:
        out_dir = Path(args.out)
        vulnerable.write(out_dir / "evidence-unguarded.json")
        hardened.write(out_dir / "evidence-guarded.json")
        print(f"evidence written to {out_dir}")

    if failures:
        print(f"{len(failures)} probe(s) are not falsifiable:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure.probe_id} ({failure.control_id}): {failure.reason}", file=sys.stderr)
        return 1

    print(f"all {len(vulnerable.records)} probes detect the absence of their control "
          f"and pass in its presence")
    return 0


def cmd_matrix(args: argparse.Namespace) -> int:
    """Prove each probe reacts to its own control and to nothing else."""
    catalog = load_catalog(_catalog_path(args.catalog))
    target = Target(args.target)
    recorded_at = resolve_timestamp(args.run_timestamp)

    guardrails, rows = run_matrix(
        target, catalog, run_id=args.run_id, recorded_at=recorded_at, trials=args.trials
    )
    control_ids = sorted({cid for outcomes in rows.values() for cid in outcomes})
    by_guardrail = {c.guardrail: c.id for c in catalog.values() if c.guardrail}

    header = "  disabled  " + "".join(f"{cid.split('-')[-1]:>10}" for cid in control_ids)
    print("independence matrix — one guardrail disabled per row")
    print(f"  target    {target.base_url}")
    print()
    print(header)
    print("  " + "-" * (len(header) - 2))
    for disabled in guardrails:
        cells = "".join(
            ("    BREACH" if rows[disabled].get(cid) == "BREACHED" else
             "      held" if rows[disabled].get(cid) == "HELD" else "     error")
            for cid in control_ids
        )
        print(f"  {disabled:<10}{cells}   (expects {by_guardrail.get(disabled, '?')})")

    failures = check_independence(catalog, rows)
    print()

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "run_id": args.run_id,
                    "recorded_at": recorded_at,
                    "target": target.base_url,
                    "guardrails": guardrails,
                    "controls": control_ids,
                    "expected_breach": by_guardrail,
                    "rows": rows,
                    "independent": not failures,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"matrix written to {out}")

    if failures:
        print(f"{len(failures)} independence failure(s):", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    print("every probe breached exactly when its own guardrail was removed")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    bundle = load_bundle(Path(args.evidence))
    matrix = None
    if args.matrix:
        matrix_path = Path(args.matrix)
        if matrix_path.is_file():
            matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        else:
            print(f"note: no matrix at {matrix_path}; report will omit it", file=sys.stderr)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(bundle, matrix), encoding="utf-8")
    print(f"report written to {out}")
    return 0


def cmd_limits(args: argparse.Namespace) -> int:
    """Execute the documented limitations instead of asserting them."""
    target = Target(args.target)
    results = run_demonstrations(target)

    print("limitation demonstrations (fully guarded target)")
    print("  a documented weakness is a claim; this runs it")
    print()

    escalated = 0
    for demo in results:
        print(f"  {demo.outcome:<15} {demo.id}  {demo.title}")
        print(f"       limitation  {demo.limitation}")
        print(f"       documented  {demo.documented_in}")
        print(f"       attack      {demo.attack}")
        for label, detail in demo.observations:
            print(f"         {label}: {detail}")
        print()
        if demo.outcome == ESCALATED:
            escalated += 1

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps([asdict(d) for d in results], indent=2) + "\n", encoding="utf-8"
        )
        print(f"  written to {out}")

    if escalated:
        print(
            f"{escalated} demonstration(s) ESCALATED: a documented weakness was bypassed AND "
            f"the control behind it also failed. That is a finding against the architecture.",
            file=sys.stderr,
        )
        return 1
    return 0


def cmd_corroborate(args: argparse.Namespace) -> int:
    """Check every catalog reference against the SCF crosswalk's citation space."""
    root = _catalog_path(args.catalog)
    catalog = load_catalog(root)
    findings = corroborate(catalog, root / "corroboration" / "cache", offline=args.offline)

    by_status: dict[str, list] = {"resolved": [], "unresolved": [], "not_corroboratable": []}
    for f in findings:
        by_status[f.status].append(f)

    print("catalog reference corroboration (Secure Controls Framework crosswalk)")
    print("  establishes: the citation exists in that framework's own numbering")
    print("  does NOT establish: that our control satisfies it")
    print()

    for finding in findings:
        if finding.status == "resolved":
            sample = ", ".join(finding.matched[:3])
            more = f" +{len(finding.matched) - 3}" if len(finding.matched) > 3 else ""
            print(f"  ok    {finding.control_id}  {finding.framework} {finding.reference}")
            print(f"          -> {sample}{more}  ({finding.scf_controls} SCF controls)")
        elif finding.status == "unresolved":
            print(f"  MISS  {finding.control_id}  {finding.framework} {finding.reference}")
            print(f"          {finding.note}")

    print()
    for framework, reason in sorted(
        {(f.framework, f.note) for f in by_status["not_corroboratable"]}
    ):
        print(f"  n/a   {framework}: {reason}")

    print()
    print(f"  {len(by_status['resolved'])} resolved, {len(by_status['unresolved'])} unresolved, "
          f"{len(by_status['not_corroboratable'])} not corroboratable")

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps([asdict(f) for f in findings], indent=2) + "\n", encoding="utf-8"
        )
        print(f"  written to {out}")

    if args.strict and by_status["unresolved"]:
        return 1
    return 0


def cmd_catalog(args: argparse.Namespace) -> int:
    catalog = load_catalog(_catalog_path(args.catalog))

    # The catalog is authored in YAML and parsed here, where threat identifiers are validated
    # against catalog/threats/ and crosswalk confidence is constrained. Emitting a JSON snapshot
    # gives other components a machine-readable view without reimplementing any of that — a
    # second YAML reader in a second language is a second set of semantics to keep in step.
    if args.json:
        snapshot = {
            "schema": "proofplane.catalog/v1",
            "controls": [
                {
                    "id": c.id,
                    "title": c.title,
                    "guardrail": c.guardrail,
                    "statement": c.statement,
                    "rationale": c.rationale,
                    "limits": c.limits,
                    "proved_by": c.proved_by,
                    "assertion": c.assertion,
                    "threat": {
                        "atlas": [asdict(t) for t in c.atlas],
                        "owasp_asi": [asdict(t) for t in c.owasp_asi],
                    },
                    "crosswalk": [asdict(m) for m in c.crosswalk],
                    "references": c.references,
                }
                for c in catalog.values()
            ],
        }
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
        print(f"catalog snapshot written to {out} ({len(catalog)} controls)")
        return 0

    frameworks: dict[str, int] = {}

    for control in catalog.values():
        print(f"{control.id}  {control.title}")
        print(f"  guardrail {control.guardrail}   proved by {', '.join(control.proved_by)}")
        threats = [t.id for t in control.atlas] + [t.id for t in control.owasp_asi]
        print(f"  threats   {', '.join(threats) or '(none)'}")
        for mapping in control.crosswalk:
            frameworks[mapping.framework] = frameworks.get(mapping.framework, 0) + 1
            label = f" ({mapping.label})" if mapping.label else ""
            print(f"    {mapping.framework:<38} {mapping.reference}{label:<22} "
                  f"[{mapping.confidence}]")
        print()

    print(f"{len(catalog)} controls, {sum(frameworks.values())} mappings across "
          f"{len(frameworks)} frameworks")
    for name, count in sorted(frameworks.items(), key=lambda kv: -kv[1]):
        print(f"  {count:>3}  {name}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="proofplane-probe", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalog", help="path to the control catalog directory")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="execute the probe suite and write evidence")
    run.add_argument("--target", default="http://127.0.0.1:8080")
    run.add_argument("--out", default="evidence")
    run.add_argument("--trials", type=int, default=3)
    run.add_argument("--run-id", default="local")
    run.add_argument("--run-timestamp", help="fixed ISO-8601 stamp for reproducible evidence")
    run.add_argument("--only", nargs="*", help="probe ids to run")
    run.add_argument("--fail-on-breach", action="store_true",
                     help="exit non-zero if any control breached")
    run.set_defaults(func=cmd_run)

    verify = sub.add_parser("verify", help="prove every probe can detect its control's absence")
    verify.add_argument("--vulnerable", default="http://127.0.0.1:8080")
    verify.add_argument("--hardened", default="http://127.0.0.1:8081")
    verify.add_argument("--trials", type=int, default=1)
    verify.add_argument("--run-id", default="verify")
    verify.add_argument("--run-timestamp")
    verify.add_argument("--out")
    verify.set_defaults(func=cmd_verify)

    matrix = sub.add_parser("matrix", help="prove each probe reacts only to its own control")
    matrix.add_argument("--target", default="http://127.0.0.1:8081",
                        help="a target that starts fully hardened")
    matrix.add_argument("--trials", type=int, default=1)
    matrix.add_argument("--run-id", default="matrix")
    matrix.add_argument("--run-timestamp")
    matrix.add_argument("--out", default="evidence/matrix.json")
    matrix.set_defaults(func=cmd_matrix)

    report = sub.add_parser("report", help="render an evidence bundle as HTML")
    report.add_argument("--evidence", default="evidence/evidence.json")
    report.add_argument("--out", default="evidence/report.html")
    report.add_argument("--matrix", help="path to matrix.json to embed the independence matrix")
    report.set_defaults(func=cmd_report)

    limits = sub.add_parser(
        "limits", help="execute the documented limitations against a fully guarded target"
    )
    limits.add_argument("--target", default="http://127.0.0.1:8081")
    limits.add_argument("--out", default="evidence/limits.json")
    limits.set_defaults(func=cmd_limits)

    corr = sub.add_parser(
        "corroborate", help="check catalog references against the SCF crosswalk citation space"
    )
    corr.add_argument("--offline", action="store_true", help="use only the cached crosswalks")
    corr.add_argument("--out", default="catalog/corroboration/report.json")
    corr.add_argument("--strict", action="store_true", help="exit non-zero on any unresolved ref")
    corr.set_defaults(func=cmd_corroborate)

    catalog = sub.add_parser("catalog", help="print the control catalog")
    catalog.add_argument("--json", metavar="PATH",
                         help="write a machine-readable snapshot here instead of printing")
    catalog.set_defaults(func=cmd_catalog)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except TargetError as exc:
        print(f"target error: {exc}", file=sys.stderr)
        print("is the target running? see target/README or the repo quickstart", file=sys.stderr)
        return 2
    except (ValueError, KeyError, FileNotFoundError) as exc:
        print(f"catalog error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
