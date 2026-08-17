# Third-party notices

This repository vendors and consumes the following third-party material.

## Vendored

### NIST OSCAL JSON schema

`catalog/schema/vendor/oscal_assessment-results_schema.json`

The Open Security Controls Assessment Language assessment-results JSON schema, version 1.1.2,
from the NIST OSCAL project.

- Source: <https://github.com/usnistgov/OSCAL/releases/download/v1.1.2/oscal_assessment-results_schema.json>
- Project: <https://pages.nist.gov/OSCAL/>
- Status: a work of the United States Government, not subject to copyright protection in the
  United States (17 U.S.C. §105). NIST asks that any derived work not imply NIST endorsement.
  This project does not claim any endorsement by NIST.

Vendored rather than fetched at run time so that `npm run validate:oscal` works offline and in
CI without depending on a release asset that may move. The file is unmodified.

## Consumed at build or run time, not vendored

### Secure Controls Framework crosswalk (via scf-api)

`proofplane-probe corroborate` fetches framework crosswalks from the GRC Engineering Club's
scf-api and caches them under `catalog/corroboration/cache/`.

- Source: <https://github.com/GRCEngClub/scf-api>
- Upstream data: Secure Controls Framework, <https://securecontrolsframework.com/>

Cached responses are committed so the corroboration report is reproducible without network
access. They are upstream data, unmodified.

### MITRE ATLAS technique identifiers

`catalog/threats/mitre-atlas.yaml` records technique identifiers and names transcribed from the
MISP galaxy ATLAS mirror.

- Mirror: <https://github.com/MISP/misp-galaxy> (CC0-1.0)
- Canonical: <https://atlas.mitre.org/>

ATLAS is a MITRE trademark. Identifiers are cited for interoperability; no affiliation with or
endorsement by MITRE is claimed or implied.

### OWASP Top 10 for Agentic Applications

`catalog/threats/owasp-asi-2026.yaml` records the ten identifiers and titles of the 2026 list.

- Project: <https://genai.owasp.org/>

Titles were transcribed from secondary documentation rather than the OWASP primary document;
the file says so. No OWASP text beyond the risk titles is reproduced.

## Not reproduced anywhere in this repository

The following are referenced **by identifier only**. None of their text appears here, and none
is redistributable:

- ISO/IEC 42001:2023, ISO/IEC 27001:2022, ISO/IEC 27002:2022, ISO/IEC 27701
- AIUC-1
- UK AI Cyber Security Code of Practice

NIST AI RMF 1.0, the EU AI Act, and the GDPR are freely available and are likewise cited by
identifier.
