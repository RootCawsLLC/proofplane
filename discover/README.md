# discover

Inventories the AI surface of a source tree and emits a CycloneDX 1.6 AI/ML bill of materials.

```bash
go run . --root .. --declared ../catalog/declared-ai.txt --out ../evidence/aibom.json
```

You cannot govern what you have not inventoried. Every control in this repository is scoped to a
model identifier, and something has to establish which identifiers are actually in play before
that scoping means anything. This is that something, and it records the line of source that says
so.

## What it detects

| Rule | Kind | Looks at |
| --- | --- | --- |
| `AID-001/2/3` | model | Anthropic, OpenAI and open-weight model identifiers, anywhere |
| `AID-010/011` | sdk | Provider SDKs in dependency manifests and in source imports |
| `AID-020/021` | mcp-server | MCP server packages and `mcpServers` blocks in config |
| `AID-030` | credential-ref | Provider credential **variable names** — never values |
| `AID-040` | cloud-resource | Bedrock, SageMaker, Vertex, Cognitive Services in IaC |

## Three properties worth arguing for

**Every component carries provenance.** `proofplane:evidence` properties hold `file:line` for up
to ten occurrences. An inventory entry a reader cannot trace back to a line of source is an
assertion, and this repository does not ship those.

**Output is byte-deterministic.** Same tree, same bytes — including the serial number, which is
a UUIDv5 over the component set. A committed AIBOM therefore produces a reviewable diff when the
AI surface changes and no diff when it does not. An inventory that churns on every run is one
nobody reads.

**Credentials are evidence, not assets.** Credential variable names appear in run metadata as
proof a provider is in use. They are never emitted as components, because a bill of materials
listing credential names is a map for whoever obtains it — and this one gets committed.

## Undeclared components

`--declared` takes a file of sanctioned names. Anything found and not on it is reported
`UNDECLARED`; `--fail-on-undeclared` makes that a non-zero exit. This is the question PP-C008
asks about tools, asked about models, SDKs and MCP servers.

An empty declared list flags everything. That is the correct starting position for a first scan.

## Limits

Static analysis only. It cannot see a model selected at runtime from a database, a name
assembled by string concatenation, a dynamically loaded SDK, or somebody using a chat interface
in a browser. It inventories the **declared** AI surface.

It also has a false-positive class it found in itself — detection rules contain the identifiers
they detect. `.discoverignore` handles it, and every line in that file is a place the inventory
is deliberately blind, which is why each carries a reason. The full account is in
[../docs/HONEST-LIMITS.md](../docs/HONEST-LIMITS.md).

## Why Go

A concurrent walk over a filesystem applying cheap regexes to many files is the shape of problem
Go is good at, and the worker pool is the natural expression of it. The rest of the harness is
Python and TypeScript because those suit what they do. Picking the language per component rather
than per repository is the whole justification — a third language added for its own sake would
be worse than two.
