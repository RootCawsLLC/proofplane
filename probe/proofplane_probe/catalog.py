"""Load the control catalog.

Controls are data, not code. A control is a claim about the system plus the crosswalk that says
which framework requirements the claim bears on, plus the identifier of the probe that proves it.
Nothing here evaluates anything — evaluation is the probe's job, and keeping the two apart is what
lets the catalog be reviewed by someone who does not read Python.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

CONFIDENCE_ORDER = {"high": 3, "medium": 2, "low": 1}


@dataclass(frozen=True)
class Mapping:
    framework: str
    reference: str
    reference_kind: str
    confidence: str
    basis: str
    label: str = ""

    def __post_init__(self) -> None:
        if self.confidence not in CONFIDENCE_ORDER:
            raise ValueError(
                f"{self.framework} {self.reference}: confidence must be one of "
                f"{sorted(CONFIDENCE_ORDER)}, got {self.confidence!r}"
            )


@dataclass(frozen=True)
class ThreatRef:
    id: str
    name: str
    confidence: str


@dataclass(frozen=True)
class Control:
    id: str
    title: str
    guardrail: str
    statement: str
    rationale: str
    proved_by: list[str]
    assertion: dict[str, str]
    atlas: list[ThreatRef] = field(default_factory=list)
    owasp_asi: list[ThreatRef] = field(default_factory=list)
    crosswalk: list[Mapping] = field(default_factory=list)
    limits: str = ""
    references: list[str] = field(default_factory=list)

    def frameworks(self) -> list[str]:
        seen: list[str] = []
        for m in self.crosswalk:
            if m.framework not in seen:
                seen.append(m.framework)
        return seen


@dataclass(frozen=True)
class ThreatCatalog:
    """Canonical technique identifiers and names, loaded from catalog/threats/*.yaml.

    Control files cite techniques by id. Every citation is checked against this catalog on load:
    an unknown id is an error, and a name that disagrees with the canonical one is an error.

    This exists because the first version of this catalog contained three OWASP identifiers that
    were confidently wrong. Prose in a YAML file cannot be wrong loudly; a loader can.
    """

    framework: str
    source: str
    names: dict[str, str]

    def check(self, ref_id: str, ref_name: str, origin: str) -> str:
        if ref_id not in self.names:
            raise ValueError(
                f"{origin}: {ref_id!r} is not in the {self.framework} catalog "
                f"({len(self.names)} known ids). Add it to catalog/threats/ with a source, "
                f"or correct the citation."
            )
        canonical = self.names[ref_id]
        if ref_name and ref_name != canonical:
            raise ValueError(
                f"{origin}: {ref_id} is named {canonical!r} in the {self.framework} catalog, "
                f"but the control says {ref_name!r}."
            )
        return canonical


def load_threat_catalogs(root: Path) -> dict[str, ThreatCatalog]:
    """Keyed by the control-file field name: 'atlas' and 'owasp_asi'."""
    threats_dir = root / "threats"
    mapping = {"atlas": "mitre-atlas.yaml", "owasp_asi": "owasp-asi-2026.yaml"}
    catalogs: dict[str, ThreatCatalog] = {}

    for key, filename in mapping.items():
        path = threats_dir / filename
        if not path.is_file():
            raise FileNotFoundError(f"missing threat catalog {path}")
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        catalogs[key] = ThreatCatalog(
            framework=str(data["framework"]),
            source=str(data.get("source") or data.get("canonical", "")),
            names={str(t["id"]): str(t["name"]) for t in data["techniques"]},
        )
    return catalogs


def _threats(
    raw: list[dict[str, Any]] | None,
    catalog: ThreatCatalog | None,
    origin: str,
) -> list[ThreatRef]:
    refs: list[ThreatRef] = []
    for t in raw or []:
        ref_id = str(t["id"])
        name = str(t.get("name", ""))
        if catalog is not None:
            name = catalog.check(ref_id, name, origin)
        refs.append(ThreatRef(id=ref_id, name=name, confidence=str(t.get("confidence", "low"))))
    return refs


def load_control(path: Path, threats: dict[str, ThreatCatalog] | None = None) -> Control:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    threat = data.get("threat") or {}
    catalogs = threats or {}
    origin = f"{path.name}"

    control = Control(
        id=str(data["id"]),
        title=str(data["title"]),
        guardrail=str(data.get("guardrail", "")),
        statement=str(data.get("statement", "")).strip(),
        rationale=str(data.get("rationale", "")).strip(),
        limits=str(data.get("limits", "")).strip(),
        proved_by=[str(p) for p in data.get("proved_by", [])],
        assertion={k: str(v).strip() for k, v in (data.get("assertion") or {}).items()},
        atlas=_threats(threat.get("atlas"), catalogs.get("atlas"), origin),
        owasp_asi=_threats(threat.get("owasp_asi"), catalogs.get("owasp_asi"), origin),
        crosswalk=[
            Mapping(
                framework=str(m["framework"]),
                reference=str(m["reference"]),
                reference_kind=str(m.get("reference_kind", "unspecified")),
                confidence=str(m.get("confidence", "low")),
                basis=str(m.get("basis", "")).strip(),
                label=str(m.get("label", "")),
            )
            for m in data.get("crosswalk", [])
        ],
        references=[str(r) for r in data.get("references", [])],
    )

    if not control.proved_by:
        raise ValueError(
            f"{control.id} declares no probe. A control with no executed proof is an "
            f"assertion, which is the thing this project exists not to produce."
        )
    return control


def load_catalog(root: Path) -> dict[str, Control]:
    controls_dir = root / "controls"
    if not controls_dir.is_dir():
        raise FileNotFoundError(f"no control directory at {controls_dir}")

    threats = load_threat_catalogs(root)
    catalog: dict[str, Control] = {}
    for path in sorted(controls_dir.glob("*.yaml")):
        control = load_control(path, threats)
        if control.id in catalog:
            raise ValueError(f"duplicate control id {control.id} in {path}")
        catalog[control.id] = control

    if not catalog:
        raise ValueError(f"no controls found in {controls_dir}")
    return catalog
