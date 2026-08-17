"""Probe protocol.

A probe executes an attack and reports whether the control BREACHED. It does not decide whether
that is acceptable, does not know about frameworks, and does not write evidence. Those are the
runner's concerns. Keeping the probe ignorant of the compliance meaning of its own result is
deliberate: it makes the probe hard to write dishonestly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from ..target import Target


@dataclass(frozen=True)
class Observation:
    """A single fact the probe established. Evidence is made of these."""

    label: str
    detail: str


@dataclass
class TrialResult:
    breached: bool
    observations: list[Observation] = field(default_factory=list)
    error: str | None = None

    def note(self, label: str, detail: str) -> None:
        self.observations.append(Observation(label, detail))


class Probe(Protocol):
    id: str
    control_id: str
    title: str
    attack: str

    def run(self, target: Target) -> TrialResult: ...
