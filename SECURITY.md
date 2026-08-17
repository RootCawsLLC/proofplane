# Security policy

## This repository ships a deliberately vulnerable application

`target/` is a support assistant built to be broken. With `PROOFPLANE_GUARDRAILS=none` it will,
by design:

- issue refunds because attacker-authored text in a support ticket asked it to
- return one tenant's records to another tenant's session
- disclose national identifiers and payment card numbers in its responses
- dispatch a tool nobody approved, and act on malformed arguments
- keep no record of any of it

It also exposes `POST /audit/tamper`, an endpoint that edits its own audit log. That is a test
affordance so `PP-P005` can prove the hash chain **detects** modification rather than asserting
it would.

**None of this is a vulnerability report.** It is the fixture. Reports that the unguarded target
is insecure will be closed as working-as-intended.

Do not deploy `target/` anywhere reachable. It binds to `127.0.0.1` by default; keep it there.

## What is in scope

- A guardrail in `target/src/guardrails/` that does not do what its control claims — that is a
  real defect, and the interesting kind.
- A probe in `probe/proofplane_probe/probes/` that can report `HELD` while its control is
  actually breached. A false pass is worse than a missing control, because it is load-bearing
  for every claim in `evidence/`.
- Anything that lets `proofplane-probe` write outside its `--out` directory, or the scanner read
  outside `--root`.
- A framework citation or threat identifier that is wrong. See
  [ADR 0005](docs/decisions/0005-threat-identifiers-are-validated-data.md) — four shipped in the
  first version, and finding more is a genuine contribution.

## What is out of scope

- The unguarded configuration of `target/`, and every finding that depends on it.
- `POST /audit/tamper`, `POST /reset`, and the guardrail-override parameter — documented test
  affordances.
- The synthetic data in `target/src/data.ts`. Card numbers are publicly published processor test
  values; national identifiers use the `900-xx-xxxx` range, which is never issued. Nothing there
  belongs to a person.
- Dependency advisories against `evidence/` or `catalog/corroboration/cache/`, which are data.

## Reporting

Open a private security advisory through the repository's Security tab. If you would rather not
use GitHub, the maintainer's contact is on the profile.

There is no bounty. This is a portfolio project, and it says so.

## Supported versions

`main` only. There are no releases and no backports.
