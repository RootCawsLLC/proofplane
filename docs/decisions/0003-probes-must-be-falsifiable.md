# 0003 — A probe must be shown to fail before its passes mean anything

**Status:** accepted · **Date:** 2026-08-10

## Context

A test suite that has never failed is indistinguishable from a test suite that cannot fail.
This is the standard failure mode of compliance automation: a check is written, it returns
green, and nobody establishes that it would return red under the condition it claims to detect.
The result looks exactly like assurance and provides none.

ADR 0001 says a control is satisfied only when an executed attack failed. That rule is worthless
if the attack was never capable of succeeding.

## Decision

Two properties are required of every probe, and both are enforced in CI before any evidence is
produced.

### 1. Falsifiability — `proofplane-probe verify`

The suite runs against two targets: one with every guardrail disabled, one with all of them
enabled. Every probe must report `BREACHED` against the first and `HELD` against the second.

A probe that reports `HELD` against an unguarded target is not measuring its control. A probe
that reports `BREACHED` against a guarded one is a false positive. Both make every other result
in the run untrustworthy, so both are hard failures rather than warnings.

### 2. Independence — `proofplane-probe matrix`

Falsifiability shows a probe reacts to the absence of its control. It does not show the probe
reacts to *nothing else*. A probe could be passing because some unrelated guardrail happens to
mask the attack, and the control it names would be decorative.

So: disable one guardrail at a time and run the whole suite against each configuration. The
diagonal must breach; every cell off it must hold.

```
  disabled        C001      C002      C003      C004      C005      C006
  G1            BREACH      held      held      held      held      held
  G2              held    BREACH      held      held      held      held
  G3              held      held    BREACH      held      held      held
  G4              held      held      held    BREACH      held      held
  G5              held      held      held      held    BREACH      held
  G6              held      held      held      held      held    BREACH
```

This forces a one-to-one relationship between guardrails and controls, which a unit test asserts.

It also makes a specific class of error visible. PP-P003 detects a cross-tenant read by looking
for the other tenant's account id and account-holder name — deliberately **not** their email
address, because the redaction filter (G4) removes email addresses. Had the probe looked for the
email, then with G3 disabled and G4 enabled it would have reported `HELD`: a real cross-tenant
breach, masked by an unrelated control, indistinguishable from success. The matrix is what turns
that from a reasoning step somebody has to trust into a check that runs.

## Consequences

**Good.** The suite has a test suite, and it is the reason to believe the rest of the output.
The matrix is also the single most legible artefact in the project: a reader who does not care
about GRC can see in six rows what is being claimed.

**Costly.** Every control must be independently toggleable in the target, which constrains how
guardrails can be written — no guardrail may depend on another being present. That is a real
design restriction and occasionally an awkward one. It also means the target needs a
reconfiguration endpoint (`POST /reset` with a guardrail override), which is a test affordance
in production code.

**Limit.** The matrix proves independence for the configurations tested — all-but-one. It does
not test arbitrary subsets, so an interaction that only appears with two specific guardrails
disabled would not be caught. Full subset coverage is 2⁶ configurations; it is not obviously
worth it, and this note exists so the gap is stated rather than implied away.
