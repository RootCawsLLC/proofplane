# 0001 — A control is satisfied only when an executed attack failed

**Status:** accepted · **Date:** 2026-08-10

## Context

The dominant pattern in AI governance tooling is to represent a control as a document: a policy
PDF, a questionnaire answer, a screenshot of a configuration page, a checkbox in a platform. The
artefact asserts that a control exists. It does not establish that the control does anything.

This is not a criticism of any one product. It is a property of how the category evolved —
from audit, where evidence is something you *examine*, rather than from engineering, where it is
something you *run*. Meanwhile the frameworks moved: AIUC-1 requires adversarial technical
testing at least quarterly, and the EU AI Act's Article 15 speaks about resilience to attack,
not about documentation of intent to be resilient.

## Decision

**A control in this repository is reported satisfied only when an attack was executed against a
running system and failed.**

Consequences that follow, all of them load-bearing:

1. Every control names a probe (`proved_by`). A control with no probe fails to load — the
   catalog loader raises rather than skipping it.
2. Every probe names a control. A probe naming a control that does not exist fails a test.
3. Evidence records carry the observations the probe made, not a status. The status is derived.
4. There is no manual override. No field anywhere sets a control to satisfied.
5. `EXAMINE` and `INTERVIEW` do not appear in the OSCAL output. Every observation is `TEST`,
   because that is what happened.

## Consequences

**Good.** The claim is checkable by a stranger. Every status on the report links back to the
attack that produced it. Coverage is honest by construction — a control nobody can write a probe
for simply is not in the catalog, which is a more useful signal than a green box.

**Costly.** Controls that resist automated testing — governance structures, training, contracts,
roles and responsibilities — cannot be represented at all. ISO 42001 is substantially made of
those, so this repository will never cover it end to end and should not claim to. That is the
price of the rule, and it is worth paying, because the alternative is a catalog where the
testable and the asserted look identical.

**Unresolved.** Some controls are testable but only destructively or only in production. Phase 0
sidesteps this by governing a fixture. Real deployments will not have that luxury.
