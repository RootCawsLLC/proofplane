#!/usr/bin/env node
/**
 * Validate emitted assessment results against the NIST OSCAL 1.1.2 JSON schema.
 *
 * Why Node rather than Python, where the rest of the probe harness lives: the OSCAL schema uses
 * ECMA-262 regular expressions containing Unicode property escapes (`\p{L}` and friends).
 * Python's `re` cannot compile those, so `jsonschema` raises before it validates anything —
 * which looks exactly like "no errors" if you are not paying attention. ajv evaluates the
 * patterns as written.
 *
 * The schema is vendored under catalog/schema/vendor/ so this runs offline and in CI without
 * reaching out to a release asset that may move. See THIRD-PARTY-NOTICES.md.
 *
 * Usage: node scripts/validate-oscal.mjs [file...]
 *        defaults to every oscal-assessment-results.json under evidence/
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(root, 'catalog/schema/vendor/oscal_assessment-results_schema.json');

function findEvidence(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findEvidence(full));
    else if (entry === 'oscal-assessment-results.json') out.push(full);
  }
  return out;
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(p))
  : findEvidence(join(root, 'evidence'));

if (targets.length === 0) {
  console.error('no OSCAL documents found. Run scripts/assure.sh first.');
  process.exit(2);
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// The OSCAL schema declares draft-07. Ajv's default export handles it; strict mode is off
// because the schema uses `$id: "#anchor"`, a draft-07 idiom ajv warns about but supports.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
const validate = ajv.compile(schema);

let failed = 0;
for (const file of targets) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const rel = file.replace(`${root}\\`, '').replace(`${root}/`, '');

  if (validate(doc)) {
    const results = doc['assessment-results']?.results?.[0];
    console.log(
      `ok    ${rel}  (${results?.findings?.length ?? 0} findings, ` +
        `${results?.observations?.length ?? 0} observations)`,
    );
    continue;
  }

  failed += 1;
  console.error(`FAIL  ${rel}`);
  const seen = new Set();
  for (const err of validate.errors ?? []) {
    const key = `${err.instancePath}|${err.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`        ${err.instancePath || '(root)'} ${err.message}`);
    if (seen.size >= 15) {
      console.error(`        … ${(validate.errors ?? []).length - seen.size} more`);
      break;
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} document(s) are not valid OSCAL 1.1.2.`);
  process.exit(1);
}
console.log(`\n${targets.length} document(s) validate against OSCAL 1.1.2.`);
