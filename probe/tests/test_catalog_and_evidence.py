"""Tests that do not need a running target.

The catalog↔probe consistency tests matter more than they look. The whole claim of this project
is that a control status traces to an executed attack. A control naming a probe that does not
exist, or a probe naming a control that does not exist, silently breaks that trace — and the
suite would still go green, because nothing would run.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from proofplane_probe.catalog import Mapping, load_catalog, load_threat_catalogs
from proofplane_probe.evidence import EvidenceBundle, EvidenceRecord, build_record
from proofplane_probe.probes import ALL_PROBES
from proofplane_probe.probes.p004_pii_egress import _luhn
from proofplane_probe.runner import wilson_interval

CATALOG = Path(__file__).resolve().parents[2] / "catalog"


class TestCatalog(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = load_catalog(CATALOG)

    def test_catalog_is_not_empty(self) -> None:
        self.assertGreaterEqual(len(self.catalog), 12)

    def test_every_control_names_a_probe_that_exists(self) -> None:
        probe_ids = {p.id for p in ALL_PROBES}
        for control in self.catalog.values():
            for probe_id in control.proved_by:
                self.assertIn(
                    probe_id, probe_ids,
                    f"{control.id} claims to be proved by {probe_id}, which is not registered",
                )

    def test_every_probe_names_a_control_that_exists(self) -> None:
        for probe in ALL_PROBES:
            self.assertIn(
                probe.control_id, self.catalog,
                f"{probe.id} names control {probe.control_id}, which is not in the catalog",
            )

    def test_every_control_declares_a_guardrail(self) -> None:
        for control in self.catalog.values():
            self.assertTrue(control.guardrail, f"{control.id} has no guardrail to toggle")

    def test_guardrails_are_one_to_one_with_controls(self) -> None:
        # The independence matrix assumes this. If two controls shared a guardrail, disabling it
        # would breach both and the diagonal would be wrong.
        guardrails = [c.guardrail for c in self.catalog.values()]
        self.assertEqual(len(guardrails), len(set(guardrails)))

    def test_every_control_carries_a_crosswalk_with_a_stated_basis(self) -> None:
        for control in self.catalog.values():
            self.assertTrue(control.crosswalk, f"{control.id} maps to no framework")
            for mapping in control.crosswalk:
                self.assertTrue(
                    mapping.basis,
                    f"{control.id} -> {mapping.framework} {mapping.reference} states no basis. "
                    f"An unexplained mapping is an assertion.",
                )

    def test_confidence_must_be_a_known_value(self) -> None:
        with self.assertRaises(ValueError):
            Mapping(
                framework="X", reference="1", reference_kind="article",
                confidence="very sure", basis="…",
            )


class TestThreatCatalog(unittest.TestCase):
    """The regression guard for the error this whole mechanism exists to prevent.

    The first version of the control catalog cited "ASI04 Sensitive Information Disclosure",
    "ASI09 Insufficient Observability", and pointed PP-C006 at ASI10. All three were plausible
    and all three were wrong. Prose in a YAML file cannot be wrong loudly; a loader can.
    """

    def setUp(self) -> None:
        self.threats = load_threat_catalogs(CATALOG)

    def test_both_catalogs_load(self) -> None:
        self.assertEqual(len(self.threats["owasp_asi"].names), 10)
        self.assertGreaterEqual(len(self.threats["atlas"].names), 10)

    def test_every_cited_technique_resolves(self) -> None:
        catalog = load_catalog(CATALOG)
        for control in catalog.values():
            for ref in list(control.atlas) + list(control.owasp_asi):
                self.assertTrue(ref.name, f"{control.id} cites {ref.id} with no resolved name")

    def test_unknown_identifier_is_rejected(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            self.threats["owasp_asi"].check("ASI99", "", "test")
        self.assertIn("not in the", str(ctx.exception))

    def test_wrong_name_is_rejected(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            self.threats["owasp_asi"].check("ASI04", "Sensitive Information Disclosure", "test")
        self.assertIn("Agentic Supply Chain Compromise", str(ctx.exception))

    def test_sub_technique_names_are_relative_to_parent(self) -> None:
        # ATLAS names AML.T0051.001 "Indirect", not "LLM Prompt Injection - Indirect".
        self.assertEqual(self.threats["atlas"].names["AML.T0051.001"], "Indirect")


class TestEvidenceChain(unittest.TestCase):
    def _record(self, probe_id: str) -> EvidenceRecord:
        catalog = load_catalog(CATALOG)
        return build_record(
            probe_id=probe_id,
            attack="synthetic",
            control=catalog["PP-C001"],
            outcome="HELD",
            trials={"n": 1, "breached": 0, "rate": 0.0, "errors": 0},
            target={"base_url": "http://example.test", "guardrails": [], "model": {}},
            observations=[],
            recorded_at="2026-01-01T00:00:00Z",
        )

    def test_chain_verifies_when_untouched(self) -> None:
        bundle = EvidenceBundle("run", "2026-01-01T00:00:00Z", {})
        for pid in ("PP-P001", "PP-P002"):
            bundle.add(self._record(pid))
        ok, reason = bundle.verify()
        self.assertTrue(ok, reason)

    def test_chain_detects_an_edited_record(self) -> None:
        bundle = EvidenceBundle("run", "2026-01-01T00:00:00Z", {})
        for pid in ("PP-P001", "PP-P002"):
            bundle.add(self._record(pid))
        bundle.records[0].outcome = "BREACHED"
        ok, reason = bundle.verify()
        self.assertFalse(ok)
        self.assertIn("PP-P001", str(reason))

    def test_identical_input_produces_an_identical_hash(self) -> None:
        a = EvidenceBundle("run", "2026-01-01T00:00:00Z", {})
        b = EvidenceBundle("run", "2026-01-01T00:00:00Z", {})
        a.add(self._record("PP-P001"))
        b.add(self._record("PP-P001"))
        self.assertEqual(a.head_hash, b.head_hash)


class TestWilsonInterval(unittest.TestCase):
    """The point of the interval is that a small clean run does not read as proof."""

    def test_zero_breaches_in_three_is_not_reassuring(self) -> None:
        lo, hi = wilson_interval(0, 3)
        self.assertEqual(lo, 0.0)
        # A true breach rate above 50% is entirely consistent with 0/3.
        self.assertGreater(hi, 0.5)

    def test_more_trials_tighten_the_bound(self) -> None:
        _, hi3 = wilson_interval(0, 3)
        _, hi30 = wilson_interval(0, 30)
        _, hi300 = wilson_interval(0, 300)
        self.assertGreater(hi3, hi30)
        self.assertGreater(hi30, hi300)

    def test_never_degenerates_to_a_point_at_zero(self) -> None:
        # The normal approximation returns [0, 0] here, which is exactly the false confidence
        # this is guarding against.
        _, hi = wilson_interval(0, 100)
        self.assertGreater(hi, 0.0)

    def test_no_trials_is_maximally_uninformative(self) -> None:
        self.assertEqual(wilson_interval(0, 0), (0.0, 1.0))

    def test_bounds_stay_within_zero_and_one(self) -> None:
        for k, n in [(0, 1), (1, 1), (5, 5), (3, 7)]:
            lo, hi = wilson_interval(k, n)
            self.assertGreaterEqual(lo, 0.0)
            self.assertLessEqual(hi, 1.0)
            self.assertLessEqual(lo, hi)


class TestLuhn(unittest.TestCase):
    def test_accepts_published_test_cards(self) -> None:
        for number in ("4111111111111111", "5555555555554444", "378282246310005"):
            self.assertTrue(_luhn(number), number)

    def test_rejects_an_ordinary_long_number(self) -> None:
        self.assertFalse(_luhn("1234567890123456"))


if __name__ == "__main__":
    unittest.main()
