"""Export an evidence bundle as OSCAL assessment-results.

Shaped to OSCAL 1.1.2. It has NOT been validated with an OSCAL schema validator — running one is
Phase 1 work, and until it has been run this is "OSCAL-shaped", not "valid OSCAL". Saying so is
cheaper than being caught by an auditor who does run one.

Every observation carries method "TEST" because that is what actually happened: an attack was
executed and the outcome observed. Nothing here was produced by INTERVIEW or EXAMINE.
"""

from __future__ import annotations

import hashlib
import uuid
from typing import Any

from .evidence import EvidenceBundle, EvidenceRecord

NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
OSCAL_VERSION = "1.1.2"


def _uuid5(*parts: str) -> str:
    return str(uuid.uuid5(NAMESPACE, "|".join(parts)))


def _observation(record: EvidenceRecord, run_id: str) -> dict[str, Any]:
    detail = "\n".join(f"{o['label']}: {o['detail']}" for o in record.observations)
    return {
        "uuid": _uuid5(run_id, record.probe_id, "observation"),
        "title": f"{record.probe_id} — {record.attack}",
        "description": detail or "No observations recorded.",
        "methods": ["TEST"],
        "types": ["control-objective"],
        "collected": record.recorded_at,
        "props": [
            {"name": "probe-id", "value": record.probe_id, "ns": "https://proofplane.dev/ns"},
            {"name": "trials", "value": str(record.trials.get("n", 0)), "ns": "https://proofplane.dev/ns"},
            {"name": "breaches", "value": str(record.trials.get("breached", 0)), "ns": "https://proofplane.dev/ns"},
            {"name": "evidence-hash", "value": record.hash, "ns": "https://proofplane.dev/ns"},
        ]
        + [
            {"name": "atlas-technique", "value": t["id"], "ns": "https://proofplane.dev/ns"}
            for t in record.threat.get("atlas", [])
        ],
    }


def _finding(record: EvidenceRecord, run_id: str) -> dict[str, Any]:
    satisfied = record.outcome == "HELD"
    return {
        "uuid": _uuid5(run_id, record.probe_id, "finding"),
        "title": record.control_title,
        "description": (
            f"{record.control_id} was assessed by executing {record.probe_id} "
            f"{record.trials.get('n', 0)} time(s). Breaches: {record.trials.get('breached', 0)}. "
            f"Outcome: {record.outcome}."
        ),
        "target": {
            "type": "objective-id",
            "target-id": record.control_id,
            "status": {"state": "satisfied" if satisfied else "not-satisfied"},
        },
        "related-observations": [
            {"observation-uuid": _uuid5(run_id, record.probe_id, "observation")}
        ],
    }


def to_assessment_results(bundle: EvidenceBundle, *, catalog_href: str = "./catalog") -> dict[str, Any]:
    run_id = bundle.run_id
    fingerprint = hashlib.sha256(bundle.head_hash.encode("utf-8")).hexdigest()[:12]

    return {
        "assessment-results": {
            "uuid": _uuid5(run_id, "assessment-results"),
            "metadata": {
                "title": "proofplane continuous assurance run",
                "last-modified": bundle.recorded_at,
                "version": run_id,
                "oscal-version": OSCAL_VERSION,
                "props": [
                    {"name": "evidence-head-hash", "value": bundle.head_hash, "ns": "https://proofplane.dev/ns"},
                    {"name": "run-fingerprint", "value": fingerprint, "ns": "https://proofplane.dev/ns"},
                ],
            },
            "import-ap": {"href": catalog_href},
            "results": [
                {
                    "uuid": _uuid5(run_id, "result"),
                    "title": "Executed adversarial assessment",
                    "description": (
                        "Each control was assessed by executing an attack against a live target. "
                        "A control is reported satisfied only when the attack failed in every trial."
                    ),
                    "start": bundle.recorded_at,
                    "end": bundle.recorded_at,
                    "reviewed-controls": {
                        "control-selections": [
                            {
                                "include-controls": [
                                    {"control-id": r.control_id} for r in bundle.records
                                ]
                            }
                        ]
                    },
                    "observations": [_observation(r, run_id) for r in bundle.records],
                    "findings": [_finding(r, run_id) for r in bundle.records],
                }
            ],
        }
    }
