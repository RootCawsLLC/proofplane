# 0005 — Threat identifiers are validated data, not prose

**Status:** accepted · **Date:** 2026-08-10

## Context

The first version of this catalog contained four wrong threat citations:

| Cited as | Actually |
| --- | --- |
| `ASI04` Sensitive Information Disclosure | `ASI04` is **Agentic Supply Chain Compromise** |
| `ASI09` Insufficient Observability | `ASI09` is **Human-Agent Trust Exploitation** |
| `ASI10` Insecure Agent Supply Chain (on PP-C006) | supply chain is `ASI04`; `ASI10` is **Rogue Agents** |
| `AML.T0051.001` "LLM Prompt Injection - Indirect" | ATLAS names sub-techniques relative to their parent: **Indirect** |
| `AML.T0010` "AI Supply Chain Compromise" | **ML Supply Chain Compromise** |

Every one was plausible. Each named a real concern, in the right general area, with a title that
reads like something a standards body would write. None of them would have been noticed by a
reviewer who did not have the source list open beside them — and reviewers do not, which is
precisely why published crosswalks are full of this.

The catalog already had ADR 0004 requiring a confidence and a basis on every framework mapping.
That did not help here, because the errors were not in the *confidence*. They were in the
*identifier*, stated confidently and incorrectly.

## Decision

Threat frameworks become data under `catalog/threats/`, and every citation in a control file is
validated against them at load time:

- An identifier not present in the catalog is a load error.
- A name that disagrees with the catalog's canonical name is a load error.
- Each threat catalog records its **source URL**, the date it was retrieved, and — where it
  applies — an explicit note that names were transcribed from secondary material rather than the
  primary document.

Consequences elsewhere in the repository:

- Where no entry maps cleanly, the field is left **empty with a comment saying why**. PP-C004
  (sensitive data egress) and PP-C005 (tamper-evident logging) both do this: nothing in the
  agentic top ten is about either, and the blank is more informative than a stretch.
- `proofplane-probe corroborate` extends the same idea to framework citations, checking every
  reference against the Secure Controls Framework crosswalk's citation space.

## Consequences

**Good.** The class of error is now a failing build. The mechanism found a fifth error within
seconds of being switched on — `AML.T0051.001`, which had gone unnoticed through authoring,
review, and a full assurance run.

**Costly.** Adding a technique means editing two files. Threat frameworks version, so the
catalogs need periodic re-checking against upstream, and nothing here does that automatically —
a stale catalog validates happily. That is the obvious next gap.

**Deliberately limited.** The loader checks that an identifier exists and is named correctly. It
does not check that the technique is the *right* one for the control. That remains judgment, and
is what `confidence` is for.

## Note on what corroboration proves

`corroborate` resolves a framework citation against SCF's crosswalk and reports how many SCF
controls map to it. All 42 citation-bearing references in the catalog currently resolve.

That establishes the citation **exists** in that framework's own numbering. It does not
establish that the control satisfies it. The two signals are kept separate on purpose:

- **Citation existence** — checked mechanically, reported in `catalog/corroboration/report.json`.
- **Mapping aptness** — the `confidence` field, which is a human judgment and stays one.

Corroborating a citation does not raise its confidence, because knowing that `MEASURE 2.7` is a
real subcategory says nothing about whether this control belongs under it.
