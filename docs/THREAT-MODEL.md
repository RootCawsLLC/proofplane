# Threat model

## The system

An agentic customer-support assistant. A model with five tools — account lookup, ticket listing,
knowledge-base search, refund issuance, email — serving two tenants over a shared deployment.

## The trust boundary, and where it actually is

Support tickets are written by customers. Knowledge-base articles are written by staff but
edited by many hands. Both are retrieved into the model's context on demand.

That makes the context window a place where **operator instructions and attacker instructions
arrive in the same format, and the model has no reliable way to tell them apart.** Everything
below follows from that one fact.

## Adversaries

| | Capability | Motivation |
| --- | --- | --- |
| **External customer** | Can write arbitrary text into a ticket body. Cannot authenticate as another tenant. | Fraudulent refund, access to another tenant's data |
| **Curious insider** | Holds a valid session in one tenant. | Read data belonging to another tenant |
| **Compromised supply chain** | Can change which model version serves traffic. | Silently invalidate prior assurance |

## Attack paths and where the control sits

### 1. Indirect prompt injection → unauthorised financial action

`AML.T0051.001` · `ASI01`, `ASI02`

The attacker writes a directive into a ticket body. A support agent asks the assistant to
summarise open tickets. The directive enters context as retrieved data and the model acts on it.

**Two controls, deliberately layered and deliberately separate:**

- **PP-C002 (G2, sanitisation)** — strip tool-directed imperatives from untrusted spans before
  they enter context. *Defence in depth.*
- **PP-C001 (G1, authorisation)** — a privileged tool call produces no effect without an
  approval record created outside the model's context. *This is the control.*

**The load-bearing claim: prompt injection is not solvable at the input layer.** Content
filters lose to obfuscation, encoding, translation, and phrasings nobody has written a pattern
for. So the design does not try to stop the model asking for a refund. It makes asking
insufficient.

The two are separate controls precisely so a bypass of the filter does not silently become a
compromise of the system, and `target/test/agent.test.ts` contains the test that makes this
checkable: with G2 off and G1 on, the injected refund **is requested** and **produces no effect**.

### 2. Cross-tenant read through an over-scoped tool

`AML.T0057` · `ASI03`

An agent inherits the blast radius of its tools. A `lookup_account` that can see every tenant
means one successful injection reads every tenant.

**PP-C003 (G3)** resolves the caller's tenant from the session, never from model arguments.
Ordinary application authorisation — included in the catalog specifically so it is not framed
as an exotic AI problem.

### 3. Sensitive data egress in the model's own answer

`AML.T0057` · `ASI04`

The assistant is given account records and summarises them, which is what assistants do. The
system prompt says not to reveal card numbers. That instruction has an unknown failure rate.

**PP-C004 (G4)** filters the response after the model. Its failure rate is measurable, which is
the entire reason it is placed there rather than in the prompt.

### 4. Unreconstructable oversight

`ASI09` · EU AI Act Article 12

Human oversight that cannot be reconstructed after the fact is not oversight. An ordinary
application log is enough to debug and not enough to assure, because nothing prevents an entry
being edited or dropped.

**PP-C005 (G5)** chains each entry to its predecessor. PP-P005 proves the chain works by
*breaking it* — the probe edits an entry and requires verification to fail.

Honest limit: tamper-**evident**, not tamper-**proof**. See [HONEST-LIMITS.md](HONEST-LIMITS.md).

### 5. Silent model substitution

`AML.T0010` · `ASI10`

The weakest link in every other result here. "The injection was refused" is a claim scoped to a
model. If nobody declared which model, or the declaration names a moving alias, the evidence
expires at some unknown point and no diff shows it.

**PP-C006 (G6)** publishes a CycloneDX ML-BOM, requires a pinned identifier, and reconciles it
against the live runtime.

## Not modelled in Phase 0

Named because an unnamed gap reads as a claim of coverage:

- **Training-time attacks** — data poisoning, backdoors. The target consumes a hosted model.
- **Denial of wallet** — unbounded tool loops driving inference spend.
- **Multi-agent and agent-to-agent** — one agent, no delegation, no MCP servers. This is where
  most of the current risk is moving, and it is Phase 3 work.
- **Model extraction and membership inference.**
- **Availability** of any kind.

## Threat coverage

| Technique | Control | Probe |
| --- | --- | --- |
| `AML.T0010` — ML Supply Chain Compromise | PP-C006 | PP-P006 |
| `AML.T0034` — Cost Harvesting | PP-C007 | PP-P007 |
| `AML.T0051` / `.001` — LLM Prompt Injection / Indirect | PP-C002 | PP-P002 |
| `AML.T0053` — LLM Plugin Compromise | PP-C001, PP-C008, PP-C011 | PP-P001, PP-P008, PP-P011 |
| `AML.T0056` — LLM Meta Prompt Extraction | PP-C012 | PP-P012 |
| `AML.T0057` — LLM Data Leakage | PP-C003, PP-C004, PP-C010 | PP-P003, PP-P004, PP-P010 |
| `ASI01` Agent Goal Hijack | PP-C001, PP-C002, PP-C012 | PP-P001, PP-P002, PP-P012 |
| `ASI02` Tool Misuse & Exploitation | PP-C001, PP-C008, PP-C010, PP-C011 | PP-P001, PP-P008, PP-P010, PP-P011 |
| `ASI03` Agent Identity & Privilege Abuse | PP-C003, PP-C009 | PP-P003, PP-P009 |
| `ASI04` Agentic Supply Chain Compromise | PP-C006, PP-C008 | PP-P006, PP-P008 |
| `ASI06` Memory & Context Poisoning | PP-C002 | PP-P002 |
| `ASI08` Cascading Agent Failures | PP-C007 | PP-P007 |
| `ASI09` Human-Agent Trust Exploitation | PP-C009 | PP-P009 |

**Not covered, and not claimed:** `ASI05` Unexpected Code Execution, `ASI07` Insecure Inter-Agent
Communication, `ASI10` Rogue Agents. All three require capabilities the target does not have —
code execution, agent-to-agent messaging, agent spawning. They are absent rather than passing.

**Controls with no threat-list entry.** PP-C004 (sensitive data egress) and PP-C005
(tamper-evident logging) carry an empty `owasp_asi` list with a comment explaining why: nothing
in the 2026 agentic list is about either, and a stretched mapping would be worse than a blank.
PP-C005's authority is EU AI Act Article 12, which is explicit, and it does not need a
threat-list entry to justify itself.

Identifiers are validated against `catalog/threats/` at load time — an unknown identifier or a
name that disagrees with the canonical one fails the build. That mechanism exists because the
first version of this table had four of them wrong. See
[decisions/0005](decisions/0005-threat-identifiers-are-validated-data.md).
