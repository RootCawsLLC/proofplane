# Architecture

## The loop

```
                    catalog/                  which controls apply, and what
                    controls/*.yaml           each one asserts about the system
                          │
                          ▼
   target/  ◄──────  probe/  ──────►  evidence/
   system under      executes the      evidence.json (hash-chained)
   governance        attack            oscal-assessment-results.json
                                       report.html
```

Three moving parts and one rule connecting them: **a control's status is the outcome of an
attack that was executed against a running system.** There is no path in this repository by
which a control becomes satisfied because someone said so.

## `catalog/` — controls as data

One YAML file per control. Each carries a statement, the rationale for placing the control
where it is, the MITRE ATLAS and OWASP Agentic Top 10 techniques it defends against, the
identifier of the probe that proves it, and a crosswalk to the frameworks it bears on.

Controls are data rather than code so that the catalog can be reviewed by someone who does not
read Python, and so that adding a framework is a diff to a YAML file rather than a refactor.

Every crosswalk entry carries a **confidence** and a **basis**. See
[decisions/0004-crosswalk-confidence-is-a-first-class-field.md](decisions/0004-crosswalk-confidence-is-a-first-class-field.md).

## `target/` — the system under governance (TypeScript)

A deliberately non-compliant agentic support assistant. An LLM with five tools, two tenants,
a knowledge base, and a ticket queue whose bodies are written by whoever opens the ticket —
which is the untrusted-input boundary the whole threat model turns on.

Six guardrails, each independently toggleable:

| ID | Guardrail | Control | Where it sits |
| --- | --- | --- | --- |
| G1 | Approval gate on privileged tool calls | PP-C001 | Between the tool call and its effect |
| G2 | Untrusted content sanitisation | PP-C002 | Between retrieval and the context window |
| G3 | Tenant scoping | PP-C003 | Inside each data tool |
| G4 | Egress redaction | PP-C004 | After the model, before the response |
| G5 | Tamper-evident interaction log | PP-C005 | Around the whole interaction |
| G6 | Model pinning and published AIBOM | PP-C006 | At startup and on `/aibom` |
| G7 | Absolute transfer ceiling | PP-C007 | Pre-dispatch policy |
| G8 | Tool allow-list | PP-C008 | Pre-dispatch policy |
| G9 | Single-use, argument-bound approvals | PP-C009 | Inside the approval ledger |
| G10 | Egress destination allow-list | PP-C010 | Pre-dispatch policy |
| G11 | Tool argument validation | PP-C011 | Pre-dispatch policy |
| G12 | System-prompt disclosure check | PP-C012 | After the model, before the response |

**Policy runs before the approval gate.** G8, G11, G10 and G7 all reject in `guardrails/policy.ts`
*before* G1 has a chance to queue anything. A request that violates policy is refused, not
escalated — putting a human in front of a request the system already knows is invalid converts
a deterministic refusal into a judgment call, and judgment under volume is how approval
fatigue starts. It is also what keeps the probes independent: with the approval gate on and a
policy check off, the violating request is still observable as having been accepted.

**Every guardrail is deterministic code outside the model.** None of them is a prompt
instruction. That is the architectural argument the target exists to make: the model is not a
trust boundary, so controls do not get placed inside it.

Guardrails are toggleable because that is how the probe suite proves it works — see
[decisions/0003-probes-must-be-falsifiable.md](decisions/0003-probes-must-be-falsifiable.md).

### Assessment surface

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Guardrails in force, serving model, whether it is pinned |
| `POST /chat` | Drive the agent; returns the reply and the full tool-call trace |
| `POST /tickets` | The attacker's channel — arbitrary ticket body |
| `POST /reset` | Clear state; optionally reconfigure guardrails (sticky) |
| `GET /ledger` | Side effects and approvals, including the unapproved set |
| `POST /approvals/{id}/approve` | Operator-token-gated approval |
| `GET /audit` | Interaction log and chain verification |
| `POST /audit/tamper` | Test affordance — edits an entry so PP-P005 can prove detection |
| `GET /aibom` | CycloneDX 1.6 ML-BOM (404 when G6 is off) |

## `probe/` — the assessor (Python)

Six probes, one per control. A probe executes an attack and reports whether the control
breached. It does not know about frameworks, does not decide whether the result is acceptable,
and does not write evidence. Those belong to the runner, and the separation makes a probe hard
to write dishonestly.

Commands:

- **`verify`** — falsifiability. Runs the suite against an unguarded and a guarded target and
  fails if any probe does not breach on the first and hold on the second.
- **`matrix`** — independence. Disables one guardrail at a time and runs the whole suite against
  each configuration. The diagonal must breach; everything off it must hold. With twelve
  controls that is 144 probe runs.
- **`run`** — the assessment itself, producing evidence.
- **`corroborate`** — checks every framework citation against the Secure Controls Framework
  crosswalk's citation space. Establishes that a clause number is real; establishes nothing
  about whether we satisfy it.

`verify` and `matrix` gate `run` in CI. Evidence produced by probes that have not been shown to
work is exactly the artefact this project argues against.

## `catalog/threats/` — technique identifiers as validated data

`mitre-atlas.yaml` and `owasp-asi-2026.yaml` hold canonical identifiers and names with their
source and retrieval date. Every citation in a control file is checked against them on load: an
unknown identifier is an error, and a name that disagrees with the canonical one is an error.

This exists because the first version of the catalog contained four wrong threat identifiers,
all of them plausible. See
[decisions/0005-threat-identifiers-are-validated-data.md](decisions/0005-threat-identifiers-are-validated-data.md).

## `evidence/` — the output

- `evidence.json` — one record per control, hash-chained, carrying the trial count, the
  observations, the threat mapping, and the crosswalk.
- `oscal-assessment-results.json` — OSCAL-shaped assessment results. Every observation has
  method `TEST`, because that is what happened.
- `report.html` — self-contained; every status links back to the attack that produced it.

## Reproducibility

The deterministic model double means a stranger can clone this repo and reproduce the evidence
with no API key and no spend. Pass `--run-timestamp` (or set `SOURCE_DATE_EPOCH`) and the
output is byte-identical. If that were not true, "controls are proved by executed attacks"
would be a claim nobody could check, which is the same position as an attestation.

## What runs where

| | Language | Why |
| --- | --- | --- |
| `target/` | TypeScript, Node, zero runtime deps | The system being governed is a web app; it should look like one |
| `probe/` | Python, stdlib + PyYAML | A harness with a dependency tree is a harness nobody can re-run in five years |
| `catalog/` | YAML | Reviewable by people who do not read either |
