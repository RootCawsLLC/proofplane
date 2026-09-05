# exposure

FAIR loss exposure bound to live control state. A guardrail that stops holding moves a dollar
figure, not a color.

```bash
npm ci && npm run build
node dist/cli.js --root ..
```

```
controls        12 holding, 0 breached

  inherent   mean    $7.90M   P90   $11.62M   P99 $15.71M
  residual   mean     $456K   P90     $898K   P99 $1.85M
  difference         $7.45M   (94.2% of inherent)
```

Run it against the unguarded evidence and residual equals inherent, difference `$0` — because no
control held, so nothing is credited. That is the whole mechanism in one comparison.

## What makes this different from a risk register

**A control is credited only if a probe executed an attack against it and the attack failed.**
Not because it is written down, not because it is deployed, not because somebody believes it
works. `bind.ts` reads `evidence/*/evidence.json` and admits controls whose outcome is `HELD`.
When a guardrail breaches, its credit disappears on the next run and the number moves.

Everything else follows from that. The register cannot drift from reality, because it has no
independent notion of what is in place.

## The cross-check

`scenarios.json` says of itself that its frequency and magnitude figures are anchored on generic
breach-cost reporting rather than AI-specific incident data, and calls that the single largest
weakness here. That was an honest sentence and an uncheckable one, because no publication was
named.

The report now carries a **generic-loss-type cross-check**: each scenario declares the loss type
it is standing in for, and the report shows the published band for that type beside the scenario's
own magnitude. Four of the eight scenarios have a published analogue. The other four are
AI-governance failures nobody prices — an incident that cannot be reconstructed, assurance
invalidated by a silent model change — and they are reported as `no published band` rather than
matched to the nearest breach study. The substitution problem becomes a count instead of a
sentence.

Three constraints on it, all deliberate:

- **The bands are not the source of any figure in `scenarios.json`.** They are a yardstick held
  against it. A scenario sitting outside a band is a question to answer, not an error to fix.
- **Magnitude only.** A per-firm annual breach rate and a per-workflow agent event rate are
  different quantities; putting them in one column would invite the comparison the data cannot
  support.
- **Vendored, not fetched.** `benchmarks.json` is a copy, stamped with its upstream commit and
  retrieval date. This report is hash-chained evidence regenerated nightly in CI, and a build that
  reached the network for these figures would make a reproducible artefact depend on a third-party
  site staying up. Refresh it by hand from
  [risk-benchmarks](https://github.com/RootCawsLLC/risk-benchmarks) and commit the change.

Delete `benchmarks.json` and the section disappears; nothing else in the run depends on it.

## Method

Each iteration is one simulated year: draw a rate from a triangular distribution, draw a Poisson
count from it, draw a magnitude per event, sum across scenarios **within the same year** before
aggregating — portfolio percentiles are percentiles of total annual loss, not a sum of
per-scenario percentiles, which is a different and wrong number.

Control effects are three-point estimates on either frequency or magnitude, sampled per
iteration. A gate reduces how often; a filter reduces how much.

Seeded throughout. Same scenarios, same control state, same seed, same answer — a Monte Carlo
whose result moves between runs cannot be committed, diffed, or argued with.

## What each control is worth

Computed by counterfactual: the simulation re-run once per control with that control alone
removed. **Read this carefully** — a low value means the loss is covered somewhere else, not that
the control is unnecessary.

In the current run PP-C001, the approval gate, prices at about $112K while PP-C006 prices at
$764K. PP-C001 is the control this repository argues is the important one. It prices low
*because* PP-C007's ceiling and PP-C010's destination allow-list already cover much of the same
loss; remove those and its value climbs sharply. Cutting the cheap-looking control and keeping
the expensive one is exactly the wrong reading, and a table of numbers invites it.

The values do not sum to the inherent-minus-residual difference, and must never be presented as
if they do.

## Allocating shared credit: Shapley values

`--shapley` computes each control's Shapley value instead of — alongside — the counterfactual
table: the average marginal contribution across every ordering of the other held controls, rather
than one ordering (everything else present). This is the standard game-theoretic answer to
splitting credit among contributors whose effects overlap, and it has a property counterfactual
value does not: **the values sum exactly to the inherent/residual difference**, by construction.

```bash
node dist/cli.js --root .. --shapley
```

```
  shapley value per control (exact, 4,096 coalitions, 2,000 iterations each — sums to the difference)
    PP-C010     $1.49M  20.0%
    PP-C003     $1.30M  17.4%
    PP-C001     $1.08M  14.4%
    ...
    total      $7.48M  (difference: $7.48M)
```

PP-C001 — $112K by counterfactual, third-highest at $1.08M by Shapley. Same evidence, same
register; the counterfactual number only ever measured PP-C001 against a world where PP-C007 and
PP-C010 were already covering the loss. Shapley averages over the orderings where PP-C001 is
credited first too.

Twelve controls is 2¹² = 4,096 coalitions, each a full simulation run — tractable, but not free,
which is why it runs at its own iteration count (`--shapley-iterations`, default 2,000) rather
than the main run's. Above `EXACT_SHAPLEY_LIMIT` controls (14; 16,384 coalitions) the exact method
is not attempted automatically — `shapleyValueOfEachControl` switches to permutation sampling.
Sampling still allocates the *total* exactly (every permutation's walk telescopes from
nothing-held to everything-held regardless of order, so the sum survives averaging); what it
approximates is the *split* between controls, and that improves with more samples.

Shapley values inherit every other limit below — they are still built on judgment-call
effectiveness estimates and evidence bound to whatever ran. What Shapley fixes is the allocation
arithmetic, not the inputs feeding it.

## Limits

The full account is in [../docs/HONEST-LIMITS.md](../docs/HONEST-LIMITS.md). Briefly:

- Frequency and magnitude are anchored on generic breach-cost reporting, **not** AI-specific
  incident data. That substitution is the largest weakness here.
- Control effectiveness is pure judgment, carried as three-point estimates so the uncertainty
  reaches the answer and every one states a basis. Reviewable is not the same as right.
- Controls are assumed to fail independently. They do not — the same attacker defeats several at
  once — so combined reduction is capped at 98% to bound how wrong that assumption gets.
- Against the deterministic model double, the figures are a statement about the guardrails, not
  about a deployed system. The JSON carries `from_live_model: false` and the report says so on
  its face.

Replace every number in `scenarios.json` with calibrated estimates before any output means
anything about your organization. This is a structure for your numbers, not a source of them.

## A guard that was wrong

The Poisson sampler originally refused any rate above 30, on the theory that anything that
frequent "is not a tail event and the framing needs revisiting". The register disproved it on the
first real run: S-03 is routine identifier disclosure at up to 200 events a year — a perfectly
coherent scenario whose expected loss is driven by frequency rather than tail, and quite possibly
the most common kind of AI-related loss there is. Refusing to model it would have quietly
excluded it.

Above λ=30 the sampler now uses a normal approximation, where Poisson skew is about 0.18 and the
error is well inside the noise of the three-point estimates feeding it.
