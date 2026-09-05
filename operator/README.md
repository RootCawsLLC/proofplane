# operator

An MCP server that exposes the assurance program to an agent, with a structural boundary
between what a model may judge and what only deterministic code may decide.

```bash
npm ci && npm run build
claude mcp add proofplane -- node "$(pwd)/dist/mcp/server.js"
```

Then ask the agent things like *"which controls breached, and what would you propose for the
worst one?"* — it can read everything and propose a fix. It cannot approve one.

## The boundary

The brief this was built against asks for "agentic AI **and** deterministic automation". The
interesting word is *and*.

| | Model | Deterministic code |
| --- | --- | --- |
| Which control a new requirement bears on | ✅ proposes | reviews |
| Wording of a Statement of Applicability entry | ✅ proposes | reviews |
| Remediation for a breached control | ✅ proposes | reviews |
| **Whether a control is satisfied** | ✖ | ✅ |
| **The evidence hash** | ✖ | ✅ |
| **What goes into the OSCAL** | ✖ | ✅ |
| **Whether a proposal takes effect** | ✖ | ✅ |

That table is enforced rather than described. Every tool invocation runs inside
`underModelAuthority`; every operation with a compliance consequence calls `assertHumanAuthority`
first and throws if it finds itself inside one. `AsyncLocalStorage` propagates through awaits, so
the guard holds at any call depth — there is a test that drives it twelve frames deep.

Full reasoning, including what this design does *not* protect against, is in
[ADR 0006](../docs/decisions/0006-the-determinism-boundary-is-enforced.md).

## Tools

**Read** — `assurance_status`, `list_controls`, `get_control`, `verify_evidence_chain`,
`independence_matrix`, `coverage_by_framework`, `ai_inventory`, `documented_limitations`,
`list_proposals`.

**Propose** — `propose_remediation`, `propose_control_mapping`. Both write to a human-gated queue
and nothing else.

**Decide** — none, and that is the point. There is no tool that approves a proposal, sets a
control status, writes evidence, or emits OSCAL. A test asserts the absence by name pattern, so a
future tool called `apply_mapping` fails the build rather than quietly reopening the question.

`verify_evidence_chain` is worth singling out: it recomputes every hash from genesis in
TypeScript against a chain written by the Python probe, rather than trusting the head hash the
file reports about itself. That cross-language check found a real defect — see below.

## The human side

```bash
proofplane-operator list
proofplane-operator approve prop_0001 --operator "RootCaws LLC" --note "reviewed the diff"
proofplane-operator triage --configuration unguarded
```

`approve` and `reject` live here rather than on the MCP surface, and that placement *is* the
control. An approval requires a named operator — an anonymous decision is not oversight — and is
single-use.

`triage` is the autonomous path: it asks a model to draft remediations for breached controls and
writes them to the same queue as everything else. Autonomy changes who writes the proposal. It
does not change who decides. Without `ANTHROPIC_API_KEY` it lists the breached controls and says
plainly that it produced no drafts.

Drafts are validated deterministically before queueing. A proposal naming a control that does not
exist, or arriving without a usable rationale, is dropped rather than queued — reviewer attention
is the scarce resource, and a proposal nobody can evaluate spends it for nothing.

## A defect this found

The evidence chain is written by Python and verified here in TypeScript. That only works if both
canonical encoders agree byte for byte, and they did not: Python writes a float of `1.0` as
`1.0`, JavaScript writes it as `1`. Every other property already matched — both use shortest
round-trip float representation, both sort keys, compact separators are identical — and that
single case was enough to make probe-written evidence unverifiable from here.

Both sides now normalize integral floats to integers before hashing, and
`test/repo.test.ts` verifies a Python-written chain from TypeScript so the two cannot drift
apart again. Had the operator simply shelled out to the Python verifier, the mismatch would still
be there and "hash-chained evidence" would have been a word rather than a property.

## Self-governance

The operator is itself an AI system governed by this platform. Adding it made
`discover --fail-on-undeclared` fail until `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk`
were entered in `catalog/declared-ai.txt` — the inventory doing its job on the person who wrote
it. Its proposal queue is shaped like the target's approval ledger for the same reason: PP-C001
says a model may request a consequential action but must not authorize one, and it would be hard
to take this repository seriously if it audited for that and did not have it.

## Limits

In-process only. A separate process that ignores `boundary.ts` is not constrained by it, and
anyone who can edit that file can remove the guard. This is a boundary against a model that has
been persuaded, not against an attacker who already has the repository. Process isolation with
separate credentials would be stronger and would also move the boundary into deployment topology
where CI cannot see it; that trade is deliberate and stated in ADR 0006.
