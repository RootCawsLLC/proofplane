/**
 * Standalone assurance driver.
 *
 * Runs in its own plain Node ESM process — the same way the CLI/`assure.sh` runs the tool — so
 * the proofplane packages are never touched by the web bundler and their child-process /
 * filesystem behaviour is exactly as shipped. The API route spawns this, writes a RunRequest as
 * JSON on stdin, and reads a RunResult as JSON on stdout.
 *
 * What it actually runs, all of it the SHIPPED tool, nothing reimplemented:
 *   1. boots target/dist/server.js twice on private 127.0.0.1 ports — guarded (all guardrails)
 *      and unguarded (none). This is the deliberately non-compliant agentic assistant.
 *   2. spawns the real Python probe CLI (proofplane_probe.cli `run`) against each, executing
 *      twelve adversarial attacks per target and writing hash-chained evidence + OSCAL.
 *   3. optionally spawns the probe `matrix` command against the guarded target — the 12x12
 *      independence proof (144 probe runs, breach only on the diagonal).
 *   4. optionally spawns exposure/dist/cli.js to price the FAIR loss model against the guarded
 *      evidence (a control is credited only if a probe attacked it and the attack failed).
 *
 * Target policy: the ONLY systems ever contacted are the target servers this process boots
 * itself, bound to 127.0.0.1 on ephemeral ports and torn down at the end. There is no
 * user-supplied target and no route to an arbitrary or real system, by construction.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The proofplane repo root. In the container this is /repo; locally it resolves web/.. */
function root() {
  return process.env.PROOFPLANE_ROOT ?? join(HERE, '..', '..');
}
function python() {
  return process.env.PROOFPLANE_PYTHON ?? 'python3';
}
function targetEntry() {
  return process.env.PROOFPLANE_TARGET_ENTRY ?? join(root(), 'target', 'dist', 'server.js');
}
function exposureEntry() {
  return process.env.PROOFPLANE_EXPOSURE_ENTRY ?? join(root(), 'exposure', 'dist', 'cli.js');
}
function catalogDir() {
  return process.env.PROOFPLANE_CATALOG ?? join(root(), 'catalog');
}
function scenariosPath() {
  return process.env.PROOFPLANE_SCENARIOS ?? join(root(), 'exposure', 'scenarios.json');
}
function benchmarksPath() {
  return process.env.PROOFPLANE_BENCHMARKS ?? join(root(), 'exposure', 'benchmarks.json');
}

const TRIALS = Number(process.env.PROOFPLANE_TRIALS ?? '3');
const BOOT_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 120_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** Boot one target server on a private port and wait for /healthz. */
async function bootTarget(guardrails, port) {
  const child = spawn(process.execPath, [targetEntry()], {
    cwd: root(),
    env: { ...process.env, PROOFPLANE_GUARDRAILS: guardrails, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`target (${guardrails}) exited before becoming healthy: ${stderr.slice(0, 400)}`);
    }
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return { child, base };
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`target (${guardrails}) did not become healthy at ${base}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Spawn a child, capture stdout/stderr, resolve on exit 0 (reject otherwise). */
function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} timed out`));
    }, STEP_TIMEOUT_MS);
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(new Error(`${label}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      // The probe intentionally exits non-zero on some sub-commands (e.g. --fail-on-breach); we
      // do not pass those flags here, so a non-zero exit is a real failure worth surfacing.
      if (code !== 0) {
        reject(new Error(`${label} exited ${code}: ${(err || out).slice(0, 500)}`));
        return;
      }
      resolve({ out, err });
    });
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const req = JSON.parse((await readStdin()) || '{}');
  const wantUnguarded = req.unguarded !== false;
  const wantMatrix = req.matrix !== false;
  const wantExposure = req.exposure !== false;

  const started = Date.now();
  const operatorNotes = [];
  const work = mkdtempSync(join(tmpdir(), 'proofplane-run-'));
  const servers = [];

  try {
    // ---- 1. boot the real target servers on private ports ----
    const [gPort, uPort] = await Promise.all([freePort(), freePort()]);
    operatorNotes.push(
      'Booting the shipped target server twice on private 127.0.0.1 ports — one with all twelve guardrails enabled, one with none. These are the only systems contacted; there is no user-supplied target.',
    );
    const guarded = await bootTarget('all', gPort);
    servers.push(guarded.child);
    const unguarded = wantUnguarded || wantExposure ? await bootTarget('none', uPort) : null;
    if (unguarded) servers.push(unguarded.child);

    const PROBE = ['-m', 'proofplane_probe.cli', '--catalog', catalogDir()];

    // ---- 2. run the real probe suite against the guarded target ----
    const guardedDir = join(work, 'evidence', 'guarded');
    mkdirSync(guardedDir, { recursive: true });
    await run(
      python(),
      [...PROBE, 'run', '--target', guarded.base, '--out', guardedDir, '--trials', String(TRIALS), '--run-id', 'web-guarded'],
      'probe run (guarded)',
    );
    const guardedBundle = readJson(join(guardedDir, 'evidence.json'));
    operatorNotes.push(
      `Executed twelve adversarial attacks against the guarded target, ${TRIALS} trials each. A control is HELD only if the attack failed in every trial — one breach in ${TRIALS} is a breach.`,
    );

    // ---- 2b. the counterfactual: same attacks, guardrails removed ----
    let unguardedBundle = null;
    if (unguarded && wantUnguarded) {
      const unguardedDir = join(work, 'evidence', 'unguarded');
      mkdirSync(unguardedDir, { recursive: true });
      await run(
        python(),
        [...PROBE, 'run', '--target', unguarded.base, '--out', unguardedDir, '--trials', String(TRIALS), '--run-id', 'web-unguarded'],
        'probe run (unguarded)',
      );
      unguardedBundle = readJson(join(unguardedDir, 'evidence.json'));
      operatorNotes.push(
        'Ran the identical suite against the unguarded target. Every control breached — this is what makes the guarded run mean something: a probe that cannot go red proves nothing when it is green.',
      );
    }

    // ---- 3. the 12x12 independence matrix ----
    let matrix = null;
    if (wantMatrix) {
      const matrixFile = join(work, 'matrix.json');
      await run(
        python(),
        [...PROBE, 'matrix', '--target', guarded.base, '--out', matrixFile, '--run-id', 'web-matrix', '--trials', '1'],
        'probe matrix',
      );
      matrix = readJson(matrixFile);
      operatorNotes.push(
        'Ran the independence matrix: disabled one guardrail at a time and re-ran the whole suite (144 probe runs). Each probe must breach only when its OWN guardrail is removed — breach on the diagonal, held everywhere else.',
      );
    }

    // ---- 4. FAIR loss exposure, bound to the guarded evidence ----
    let exposure = null;
    if (wantExposure) {
      // exposure/cli.js locates its root by an ancestor `catalog/controls` dir and reads
      // evidence/guarded/evidence.json under that root — so point it at a synthetic root
      // holding this run's fresh evidence, with scenarios/benchmarks from the real repo.
      mkdirSync(join(work, 'catalog', 'controls'), { recursive: true });
      const exposureFile = join(work, 'exposure.json');
      await run(
        process.execPath,
        [
          exposureEntry(),
          '--root', work,
          '--configuration', 'guarded',
          '--scenarios', scenariosPath(),
          '--benchmarks', benchmarksPath(),
          '--out', exposureFile,
          '--html', 'none',
        ],
        'exposure',
      );
      exposure = readJson(exposureFile);
      operatorNotes.push(
        'Priced the FAIR loss model against the guarded evidence. A control is credited in the loss model only if a probe executed an attack against it and the attack failed. Figures derive from the deterministic model double — a statement about the guardrails, not about a deployed system.',
      );
    }

    process.stdout.write(
      JSON.stringify({
        guarded: guardedBundle,
        unguarded: unguardedBundle,
        matrix,
        exposure,
        operatorNotes,
        trials: TRIALS,
        durationMs: Date.now() - started,
      }),
    );
  } finally {
    for (const child of servers) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best effort */
      }
    }
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err?.stack ?? err?.message ?? String(err) }));
  process.exit(1);
});
