# 0006 — The determinism boundary is enforced, not documented

**Status:** accepted · **Date:** 2026-08-10

## Context

The operator exposes this assurance program to an agent over MCP. That immediately raises the
question every agentic system has to answer and most answer in a README: what is the model
allowed to decide?

The split itself is not hard to state.

**Judgment** — which existing control a newly published requirement bears on. How to word a
Statement of Applicability entry. What a breached control's remediation should be. How to explain
drift to somebody who does not read YAML. All of it revisable, all of it improved by being
reviewed, none of it worse for having been drafted by a model.

**Authority** — whether a control is satisfied. What the evidence hash is. What goes into the
OSCAL. Whether a proposal takes effect. None of it revisable after the fact without leaving a
trace, and none of it improved by being persuadable.

Stating that split costs nothing and is worth about as much. Every system with a prompt-injection
problem had a document describing what its model was supposed to do.

## Decision

The boundary is a runtime guard, not a convention.

Every MCP tool invocation runs inside `underModelAuthority`, which sets an `AsyncLocalStorage`
context. Every operation carrying a compliance consequence calls `assertHumanAuthority` before
doing any work, which throws `DeterminismBoundaryError` if it finds that context active.

`AsyncLocalStorage` propagates through awaits, so the guard holds at any call depth. A tool
cannot escape it by routing through a few helpers, and a test drives that twelve frames deep to
prove it.

Consequences that follow:

- Tools declare an `effect`, and the type admits exactly two values: `read` and `propose`. Adding
  a third would be a deliberate act visible in a diff.
- There is no MCP tool that approves a proposal, sets a control status, writes evidence, or emits
  OSCAL. A test asserts the absence by name pattern, so a future tool called `apply_mapping`
  fails the build rather than quietly re-opening the question.
- `approve` and `reject` live on the CLI, which never runs inside a model context.
- An approval requires a named operator. An anonymous decision is not oversight.
- Decisions are single-use, and recorded alongside the proposal rather than folded into it — the
  proposal hash covers the substance, so deciding does not break the chain but editing does.

## Why this shape and not another

**Rejected: a permission flag on the agent.** Configuration that can be changed by whoever runs
the server is a setting, not a control. The same objection applies to a system prompt saying
"never approve anything".

**Rejected: an allow-list of tools the model may call.** Equivalent in effect, but it protects
the surface rather than the operation. A helper that grows a new caller later is protected by the
guard and is not protected by the list.

**Rejected: separate processes with separate credentials.** Stronger, and correct at scale. It
also moves the boundary into deployment topology, where it is invisible to a reader of this
repository and untestable in CI. The in-process guard is weaker and demonstrable; that trade is
deliberate and is the honest limit of this design.

## The self-referential part

This is the same control as PP-C001. That control says a model may request a consequential action
but must not authorize one, and the target is judged against it by an executed attack. It would
be difficult to take this repository seriously if it audited for that property and did not have
it — so the operator is built the way the catalog says systems should be, and the proposal queue
is shaped like the target's approval ledger on purpose.

The operator also appears in its own AI bill of materials. Adding it caused
`discover --fail-on-undeclared` to fail until `@anthropic-ai/sdk` and
`@modelcontextprotocol/sdk` were entered in `catalog/declared-ai.txt`, which is the inventory
doing its job on the person who wrote it.

## Consequences

**Good.** "The model cannot decide this" is a property the test suite checks rather than a
sentence someone has to remember. The refusal names the tool it came from, so it is diagnosable
rather than mysterious.

**Costly.** Every new operation with a compliance consequence has to remember to call the guard,
and nothing forces that. The guard catches attempts to *use* an unguarded operation from model
context only if the operation is guarded — so this reduces the problem to one reviewable
question per new function rather than eliminating it.

**Limit.** In-process only. A separate process ignoring this module is not constrained by it, and
anyone who can edit `boundary.ts` can remove it. It is a boundary against a model that has been
persuaded, not against an attacker who has the repository.
