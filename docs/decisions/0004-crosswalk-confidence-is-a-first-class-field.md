# 0004 — Every framework mapping carries a confidence and a stated basis

**Status:** accepted · **Date:** 2026-08-10

## Context

Compliance crosswalks are usually presented as facts: control X maps to ISO 42001 A.6.2.4, NIST
AI RMF MEASURE-2.7, and EU AI Act Article 15. The precision is reassuring and frequently
unearned. Three separate problems produce it:

1. **Copyright.** ISO standards are not freely redistributable. A mapping to a specific Annex A
   sub-control cannot be verified by a reader without a licensed copy, and the text cannot be
   reproduced to help them.
2. **Drift.** MITRE ATLAS is on v5.4 with agent techniques added in 2026. AIUC-1 updates
   quarterly. OWASP's agentic list is new. A mapping correct in March may not be in September.
3. **Genuine judgment.** "Tenant scoping supports EU AI Act Article 10 data governance" is a
   defensible reading, not a derivation. Presenting it identically to "Article 12 requires
   logging" flattens a real difference.

Presenting all three at the same apparent precision is how crosswalks become confidently wrong.

## Decision

Every entry in a control's `crosswalk` carries:

- `reference_kind` — what granularity is being asserted: `article`, `annex_a_group`,
  `annex_a_control`, `subcategory`, `domain`, `principle_name`, `theme`.
- `confidence` — `high`, `medium`, or `low`. Constrained; an unknown value fails to load.
- `basis` — prose saying *why* this mapping, and what was not verified. A test fails if it is
  empty.

Standing rules that follow:

- **ISO/IEC 42001 is cited at Annex A group level only** (A.2–A.10). No ISO text is reproduced
  anywhere in this repository.
- **AIUC-1 is cited at domain level only.** Requirement identifiers are not reproduced.
- **UK AI Cyber Security Code of Practice is cited by theme**, not principle number.
- **NIST AI RMF** subcategory anchors are marked `low` unless verified against the playbook.
- Freely available instruments — EU AI Act articles, ISO 27001 Annex A control numbers — may be
  cited at their natural precision, with the basis noting whether the mapping *satisfies* or
  merely *supports*.

The HTML report renders confidence per mapping, color-coded. A reader sees the uncertainty
without opening a YAML file.

## Consequences

**Good.** The catalog is honest at a glance. It also degrades gracefully: when ATLAS or AIUC-1
revises, a `low`-confidence mapping is a known-soft spot rather than a silent error. And the
discipline matches the standard this repository is held to — *mapped to* is not *satisfies*, and
saying which one you mean is the entire skill.

**Costly.** The crosswalk looks weaker than a competitor's. A control mapping to "ISO 42001 A.9,
group level, medium confidence" reads as less impressive than "A.9.2, A.9.3, A.9.4". It is less
impressive. It is also true, and a reviewer who checks will find the second kind wanting.

## Follow-on: what SCF corroboration turned out to be good for

The original intent was to ingest the Secure Controls Framework crosswalk and use it to *raise
confidence* on mappings it corroborated. Building it made clear that this was the wrong idea.

SCF can tell you that `MEASURE 2.7` is a real subcategory and that eleven SCF controls crosswalk
to it. It cannot tell you whether *this* control belongs under it. Those are different questions,
and collapsing them into one number would have quietly reintroduced the problem this ADR exists
to solve.

So `proofplane-probe corroborate` reports a separate signal and does not touch `confidence`:

- **Citation existence** — checked mechanically against SCF, reported in
  `catalog/corroboration/report.json`. Currently 42 of 42 citation-bearing references resolve.
- **Mapping aptness** — the `confidence` field. A human judgment, and it stays one.

The check earns its place anyway: invented and mistyped clause numbers are endemic in published
crosswalks and essentially nobody checks them. It is a spell-check for citations, which is a
modest thing to be, and being clear about that is the point.

It also surfaced a real modeling detail. ISO 27001 Annex A control numbers are ISO 27002
control numbers, and SCF's ISO 27001 crosswalk carries main-body clauses only. Resolving `A.8.12`
against the ISO 27001 crosswalk returns nothing — a false negative that looks like rigour.
Annex A citations resolve against `general-iso-27002-2022` and nowhere else.
