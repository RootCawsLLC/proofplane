# 0002 — The default target serves a deterministic double, not a language model

**Status:** accepted · **Date:** 2026-08-10

## Context

The probes attack an agentic application. The obvious implementation points that application at
a real frontier model. Doing so creates three problems at once:

1. **Cost and access.** Reproducing the evidence requires an API key and spend. "Clone it and
   check" stops being a real invitation, and an unverifiable claim about verification is worse
   than no claim.
2. **Non-determinism.** A model may or may not comply with an injected instruction on any given
   run. "It did not breach this time" is then ambiguous between *the control held* and *the model
   happened not to comply*.
3. **Falsifiability is unprovable.** ADR 0003 requires every probe to breach when its guardrail
   is removed. Against a stochastic model that check itself becomes flaky, so the mechanism that
   validates the suite would need its own validation.

## Decision

The default model is a **deterministic test double** that reproduces exactly one property of
language models:

> A model resolves instructions from its flattened context and does not distinguish instructions
> the operator wrote from instructions an attacker wrote into data the model was asked to read.

The double scans every message — system, user, and tool output alike — for actionable intent and
acts on whatever it finds, because it has no notion of provenance. Everything else it does
follows from that.

A live adapter (`PROOFPLANE_MODEL_PROVIDER=anthropic`) runs the identical probes, evidence
pipeline, and OSCAL export against a real model.

## Rejected alternatives

- **Record/replay of real model responses.** Reproducible, and it would let the suite exercise
  real model text. Rejected because the cassettes go stale silently and a re-recorded cassette
  looks the same in a diff as a real behavioural change.
- **A small local model.** Still non-deterministic, adds a multi-gigabyte dependency, and shifts
  the question to "is this model representative", which is harder than the one being answered.
- **Live model only.** Honest, and unreproducible by anyone without a key. Two of the three
  reasons this project exists are reproducibility and falsifiability.

## Consequences

**Good.** Anyone can clone and reproduce byte-identical evidence with `--run-timestamp`. The
falsifiability and independence checks are exact rather than statistical. CI is fast and free.

**Costly, and stated in the README rather than buried.** A `HELD` result against the double is
evidence about the *guardrail*, not about any model's safety. Anyone reading the report as
"model is safe" has been misled, so the report, the README, and HONEST-LIMITS all say what the
result is scoped to.

**Follow-on.** The double is a strawman in one specific sense: it complies with every injected
directive it can parse, where a real model sometimes refuses. This makes it a *harder* target
for the sanitisation guardrail (G2) and a *fair* one for the authorisation guardrail (G1), since
G1 does not depend on model behaviour at all. That asymmetry is itself an argument for placing
the control at the authorisation boundary.
