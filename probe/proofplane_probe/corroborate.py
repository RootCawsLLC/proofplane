"""Corroborate catalog references against the Secure Controls Framework crosswalk.

What this establishes, precisely: that a reference we cite **exists as a citation** in that
framework's own numbering, and how many SCF controls crosswalk to it.

What it does NOT establish: that our control satisfies that requirement. Nothing automated can
establish that, and a tool that implied otherwise would be the exact failure mode this project
was built to argue against. A resolved reference means the citation is real. It is a spell-check
for clause numbers, not a compliance verdict.

Useful anyway, because invented and mistyped clause numbers are endemic in published crosswalks
and nobody checks them.

Source: https://github.com/GRCEngClub/scf-api (openly licensed, machine-readable).
"""

from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .catalog import Control

SCF_BASE = "https://grcengclub.github.io/scf-api/api/crosswalks"

# Our framework labels to SCF crosswalk identifiers. Frameworks absent from SCF are listed
# explicitly with a reason rather than silently skipped.
SCF_FRAMEWORKS: dict[str, str] = {
    "ISO/IEC 42001:2023": "general-iso-42001-2023",
    "NIST AI RMF 1.0": "general-nist-100-1-ai-rmf",
    "EU AI Act": "emea-eu-ai-act-2024",
    # ISO 27001 Annex A control numbers are the ISO 27002 control numbers. SCF's ISO 27001
    # crosswalk carries main-body clauses only (4.4, 5.1, …), so an A.8.x citation resolves
    # against ISO 27002 and nowhere else. Corroborating it against the wrong catalog and
    # reporting a miss would be a false negative dressed as rigour.
    "ISO/IEC 27001:2022": "general-iso-27002-2022",
    "GDPR": "emea-eu-gdpr-2016",
    "ISO/IEC 27701": "general-iso-27701-2025",
}

# Reference kinds that name an actual citation. Domains, principle names and themes are
# deliberately imprecise (see ADR 0004) and there is nothing to look up.
CITATION_KINDS = {"article", "annex_a_group", "annex_a_control", "subcategory"}

NOT_IN_SCF: dict[str, str] = {
    "AIUC-1": "published 2025; not present in the SCF crosswalk set at time of writing",
    "UK AI Cyber Security Code of Practice": "voluntary code; not present in the SCF crosswalk set",
}


def normalise(framework: str, reference: str) -> str:
    """Bring our reference into the framework's own citation spelling."""
    ref = reference.strip()
    if framework == "NIST AI RMF 1.0":
        # SCF spells these "GOVERN 1.2"; a hyphen is a common informal variant.
        return ref.replace("-", " ")
    if framework == "EU AI Act":
        # "Article 11 / Annex IV" cites two things; corroborate the article.
        return ref.split("/")[0].strip()
    if framework == "ISO/IEC 27001:2022":
        # Annex A "A.8.12" is ISO 27002 control "8.12".
        return re.sub(r"^A\.", "", ref)
    return ref


def resolve(citations: set[str], reference: str) -> list[str]:
    """Exact match, else any citation that is a sub-clause of the reference."""
    if reference in citations:
        return [reference]
    prefix = f"{reference}."
    children = sorted(c for c in citations if c.startswith(prefix))
    if children:
        return children
    # "Article 14" against "Article 14.1(a)" — sub-clauses may not use a dot separator.
    loose = sorted(c for c in citations if re.match(rf"^{re.escape(reference)}[.( ]", c))
    return loose


@dataclass
class Finding:
    control_id: str
    framework: str
    reference: str
    normalised: str
    status: str  # resolved | unresolved | not_corroboratable
    matched: list[str]
    scf_controls: int
    note: str


def fetch_crosswalk(scf_id: str, cache_dir: Path, offline: bool = False) -> dict[str, Any]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"{scf_id}.json"
    if cached.is_file():
        return json.loads(cached.read_text(encoding="utf-8"))
    if offline:
        raise FileNotFoundError(f"no cached crosswalk for {scf_id} and --offline was given")

    with urllib.request.urlopen(f"{SCF_BASE}/{scf_id}.json", timeout=30) as resp:  # noqa: S310
        data = json.loads(resp.read().decode("utf-8"))
    cached.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return data


def corroborate(
    catalog: dict[str, Control],
    cache_dir: Path,
    offline: bool = False,
) -> list[Finding]:
    needed = {
        m.framework for c in catalog.values() for m in c.crosswalk if m.framework in SCF_FRAMEWORKS
    }
    crosswalks: dict[str, dict[str, Any]] = {}
    for framework in sorted(needed):
        data = fetch_crosswalk(SCF_FRAMEWORKS[framework], cache_dir, offline)
        crosswalks[framework] = data

    findings: list[Finding] = []
    for control in catalog.values():
        for mapping in control.crosswalk:
            if mapping.reference_kind not in CITATION_KINDS:
                findings.append(
                    Finding(
                        control.id, mapping.framework, mapping.reference, mapping.reference,
                        "not_corroboratable", [], 0,
                        f"reference_kind '{mapping.reference_kind}' does not name a citation; "
                        f"nothing to look up",
                    )
                )
                continue

            if mapping.framework in NOT_IN_SCF:
                findings.append(
                    Finding(
                        control.id, mapping.framework, mapping.reference, mapping.reference,
                        "not_corroboratable", [], 0, NOT_IN_SCF[mapping.framework],
                    )
                )
                continue

            data = crosswalks.get(mapping.framework)
            if data is None:
                findings.append(
                    Finding(
                        control.id, mapping.framework, mapping.reference, mapping.reference,
                        "not_corroboratable", [], 0,
                        "no SCF crosswalk identifier configured for this framework",
                    )
                )
                continue

            mappings = data["framework_to_scf"]["mappings"]
            citations = set(mappings)
            normalised = normalise(mapping.framework, mapping.reference)
            matched = resolve(citations, normalised)
            scf_controls = len({s for m in matched for s in mappings.get(m, [])})

            findings.append(
                Finding(
                    control.id, mapping.framework, mapping.reference, normalised,
                    "resolved" if matched else "unresolved",
                    matched[:8], scf_controls,
                    "" if matched
                    else f"no citation matching {normalised!r} in the SCF crosswalk for this "
                         f"framework ({len(citations)} citations known)",
                )
            )
    return findings
