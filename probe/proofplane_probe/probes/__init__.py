"""Probe registry."""

from __future__ import annotations

from .base import Observation, Probe, TrialResult
from .p001_approval_gate import ApprovalGateProbe
from .p002_indirect_injection import IndirectInjectionProbe
from .p003_tenant_isolation import TenantIsolationProbe
from .p004_pii_egress import PiiEgressProbe
from .p005_audit_chain import AuditChainProbe
from .p006_model_inventory import ModelInventoryProbe
from .p007_value_ceiling import ValueCeilingProbe
from .p008_tool_allowlist import ToolAllowlistProbe
from .p009_approval_replay import ApprovalReplayProbe
from .p010_egress_destination import EgressDestinationProbe
from .p011_argument_validation import ArgumentValidationProbe
from .p012_prompt_disclosure import PromptDisclosureProbe

ALL_PROBES: list[Probe] = [
    ApprovalGateProbe(),
    IndirectInjectionProbe(),
    TenantIsolationProbe(),
    PiiEgressProbe(),
    AuditChainProbe(),
    ModelInventoryProbe(),
    ValueCeilingProbe(),
    ToolAllowlistProbe(),
    ApprovalReplayProbe(),
    EgressDestinationProbe(),
    ArgumentValidationProbe(),
    PromptDisclosureProbe(),
]

__all__ = ["ALL_PROBES", "Observation", "Probe", "TrialResult"]
