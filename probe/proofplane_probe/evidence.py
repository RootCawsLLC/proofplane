"""Evidence records.

An evidence record says: this probe ran, against this target, serving this model, with these
guardrails in force, and this is what happened. It is hash-chained for the same reason the
target's own log is — so that removing an inconvenient result is detectable.

Reproducibility. Every field is derived from the run except the timestamp. Pass --run-timestamp
(or set SOURCE_DATE_EPOCH) and a re-run against the same target produces byte-identical output,
which is what makes "clone it and check" a real invitation rather than a rhetorical one.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .catalog import Control
from .probes import Observation

SCHEMA = "proofplane.evidence/v1"
GENESIS = "0" * 64

Outcome = str  # "HELD" | "BREACHED" | "ERROR"


def _normalise_numbers(value: Any) -> Any:
    """Collapse integral floats to ints before hashing.

    The one place a cross-language hash chain reliably breaks. Python writes a float of 1.0 as
    ``1.0``; JavaScript writes the same value as ``1``. Everything else already agrees — both
    languages use shortest round-trip float representation, both sort the same way, and compact
    separators match — so this single case was enough to make evidence written by the probe
    unverifiable by the operator, which would have quietly reduced "hash-chained" to a word.

    Normalizing here rather than in the stored JSON keeps the evidence readable as floats while
    making the hashed form language-neutral. The operator applies the same rule in
    operator/src/core/repo.ts, and a test verifies a Python-written chain from TypeScript.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _normalise_numbers(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalise_numbers(v) for v in value]
    return value


def canonical(value: Any) -> str:
    """Stable, language-neutral JSON so the hash does not depend on key order or float spelling."""
    return json.dumps(
        _normalise_numbers(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def resolve_timestamp(explicit: str | None) -> str:
    if explicit:
        return explicit
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if epoch and epoch.isdigit():
        return datetime.fromtimestamp(int(epoch), tz=UTC).isoformat().replace("+00:00", "Z")
    return datetime.now(tz=UTC).isoformat().replace("+00:00", "Z")


@dataclass
class EvidenceRecord:
    schema: str
    probe_id: str
    control_id: str
    control_title: str
    attack: str
    assertion: dict[str, str]
    outcome: Outcome
    trials: dict[str, Any]
    target: dict[str, Any]
    threat: dict[str, Any]
    crosswalk: list[dict[str, Any]]
    observations: list[dict[str, str]]
    recorded_at: str
    prev_hash: str = GENESIS
    hash: str = ""
    error: str | None = None

    def compute_hash(self) -> str:
        body = {k: v for k, v in asdict(self).items() if k != "hash"}
        return hashlib.sha256(canonical(body).encode("utf-8")).hexdigest()


@dataclass
class EvidenceBundle:
    run_id: str
    recorded_at: str
    target: dict[str, Any]
    records: list[EvidenceRecord] = field(default_factory=list)

    def add(self, record: EvidenceRecord) -> None:
        record.prev_hash = self.records[-1].hash if self.records else GENESIS
        record.hash = record.compute_hash()
        self.records.append(record)

    @property
    def head_hash(self) -> str:
        return self.records[-1].hash if self.records else GENESIS

    def summary(self) -> dict[str, int]:
        counts = {"HELD": 0, "BREACHED": 0, "ERROR": 0}
        for r in self.records:
            counts[r.outcome] = counts.get(r.outcome, 0) + 1
        return counts

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "run_id": self.run_id,
            "recorded_at": self.recorded_at,
            "target": self.target,
            "summary": self.summary(),
            "head_hash": self.head_hash,
            "records": [asdict(r) for r in self.records],
        }

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(self.to_dict(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    def verify(self) -> tuple[bool, str | None]:
        prev = GENESIS
        for r in self.records:
            if r.prev_hash != prev:
                return False, f"{r.probe_id}: prev_hash does not match predecessor"
            stored = r.hash
            if r.compute_hash() != stored:
                return False, f"{r.probe_id}: content does not match its hash"
            prev = stored
        return True, None


def build_record(
    *,
    probe_id: str,
    attack: str,
    control: Control,
    outcome: Outcome,
    trials: dict[str, Any],
    target: dict[str, Any],
    observations: list[Observation],
    recorded_at: str,
    error: str | None = None,
) -> EvidenceRecord:
    return EvidenceRecord(
        schema=SCHEMA,
        probe_id=probe_id,
        control_id=control.id,
        control_title=control.title,
        attack=attack,
        assertion=control.assertion,
        outcome=outcome,
        trials=trials,
        target=target,
        threat={
            "atlas": [asdict(t) for t in control.atlas],
            "owasp_asi": [asdict(t) for t in control.owasp_asi],
        },
        crosswalk=[asdict(m) for m in control.crosswalk],
        observations=[{"label": o.label, "detail": o.detail} for o in observations],
        recorded_at=recorded_at,
        error=error,
    )


def load_bundle(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
