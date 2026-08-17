#!/usr/bin/env bash
#
# One continuous-assurance run, end to end.
#
#   0. discovery       inventory the AI surface, so what follows is scoped to known models.
#   1. falsifiability  every probe must breach against an unguarded target and hold against a
#                      guarded one. If not, the probe measures nothing and the run aborts.
#   2. independence    every probe must breach only when its OWN guardrail is removed.
#   3. assessment      the suite runs against both configurations and evidence is written.
#   4. limitations     the weaknesses HONEST-LIMITS.md documents are executed, not asserted.
#   5. OSCAL           the emitted assessment results validate against the NIST 1.1.2 schema.
#   6. corroboration   every framework citation resolves in that framework's own numbering.
#
# Steps 1 and 2 gate step 3 on purpose. Evidence produced by probes that have not been shown to
# work is the same attestation habit this project exists to refuse.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TRIALS="${TRIALS:-3}"
RUN_ID="${RUN_ID:-local}"
RUN_TS="${RUN_TS:-}"
UNGUARDED_PORT="${UNGUARDED_PORT:-8080}"
GUARDED_PORT="${GUARDED_PORT:-8081}"
EVIDENCE="${EVIDENCE:-$ROOT/evidence}"

PY="${PYTHON:-python3}"
PROBE=("$PY" -m proofplane_probe.cli --catalog "$ROOT/catalog")

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 50); do
    if curl -sf "$url/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $name did not become healthy at $url" >&2
  return 1
}

echo "==> building target"
(cd target && npm run build --silent)

echo "==> starting targets"
(cd target && PROOFPLANE_GUARDRAILS=none PORT="$UNGUARDED_PORT" node dist/server.js) &
pids+=($!)
(cd target && PROOFPLANE_GUARDRAILS=all PORT="$GUARDED_PORT" node dist/server.js) &
pids+=($!)

UNGUARDED="http://127.0.0.1:$UNGUARDED_PORT"
GUARDED="http://127.0.0.1:$GUARDED_PORT"
wait_for "$UNGUARDED" "unguarded target"
wait_for "$GUARDED" "guarded target"

echo
echo "==> step 1/9  catalog snapshot"
# The catalog is authored in YAML and parsed by the probe, which validates threat identifiers
# and constrains crosswalk confidence. Emitting the JSON snapshot here means the operator reads
# a view that has already been through that validation, rather than reimplementing it.
cd "$ROOT/probe"
"${PROBE[@]}" catalog --json "$ROOT/catalog/catalog.json"
cd "$ROOT"

echo
echo "==> step 2/9  AI surface discovery"
# Discovery runs first because every control below is scoped to a model identifier, and
# something has to establish which identifiers are in play before the scoping means anything.
if command -v go >/dev/null 2>&1; then
  (cd "$ROOT/discover" && go run . \
    --root "$ROOT" \
    --declared "$ROOT/catalog/declared-ai.txt" \
    --out "$EVIDENCE/aibom.json" \
    --format text \
    --fail-on-undeclared)
else
  echo "  SKIPPED: no Go toolchain on PATH. The AI inventory is not being produced, so"
  echo "  nothing below is scoped to a verified model identifier. See discover/README.md."
fi

cd "$ROOT/probe"

echo
echo "==> step 3/9  falsifiability"
"${PROBE[@]}" verify --vulnerable "$UNGUARDED" --hardened "$GUARDED" --trials 1

echo
echo "==> step 4/9  independence"
"${PROBE[@]}" matrix --target "$GUARDED" --out "$EVIDENCE/matrix.json" \
  ${RUN_TS:+--run-timestamp "$RUN_TS"}

echo
echo "==> step 5/9  assessment"
for pair in "unguarded:$UNGUARDED" "guarded:$GUARDED"; do
  name="${pair%%:*}"
  url="${pair#*:}"
  echo
  echo "--- $name ---"
  "${PROBE[@]}" run --target "$url" --out "$EVIDENCE/$name" \
    --run-id "$RUN_ID-$name" --trials "$TRIALS" ${RUN_TS:+--run-timestamp "$RUN_TS"}
  "${PROBE[@]}" report --evidence "$EVIDENCE/$name/evidence.json" \
    --matrix "$EVIDENCE/matrix.json" --out "$EVIDENCE/$name/report.html"
done

echo
echo "==> step 6/9  documented limitations"
"${PROBE[@]}" limits --target "$GUARDED" --out "$EVIDENCE/limits.json"

echo
echo "==> step 7/9  OSCAL schema validation"
cd "$ROOT"
node scripts/validate-oscal.mjs

echo
echo "==> step 8/9  citation corroboration"
cd "$ROOT/probe"
"${PROBE[@]}" corroborate --offline --strict \
  --out "$ROOT/catalog/corroboration/report.json" 2>/dev/null \
  || "${PROBE[@]}" corroborate --strict --out "$ROOT/catalog/corroboration/report.json"

echo
echo "==> step 9/9  loss exposure"
# Last, because it prices what the run established and nothing else. A control is credited in
# the loss model only if a probe executed an attack against it and the attack failed.
cd "$ROOT/exposure"
npm run --silent build
node dist/cli.js --root "$ROOT" \
  --out "$EVIDENCE/exposure.json" --html "$EVIDENCE/exposure.html"
cd "$ROOT"

echo
echo "==> done. evidence in $EVIDENCE"
