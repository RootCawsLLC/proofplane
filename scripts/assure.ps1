<#
.SYNOPSIS
  One continuous-assurance run, end to end. Windows equivalent of scripts/assure.sh.

.DESCRIPTION
  1. falsifiability  every probe must breach against an unguarded target and hold against a
                     guarded one. If not, the probe measures nothing and the run aborts.
  2. independence    every probe must breach only when its OWN guardrail is removed.
  3. assessment      the suite runs against both configurations and evidence is written.
#>
[CmdletBinding()]
param(
  [int]$Trials = 3,
  [string]$RunId = 'local',
  [string]$RunTimestamp,
  [int]$UnguardedPort = 8080,
  [int]$GuardedPort = 8081
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path $root 'evidence'
$unguarded = "http://127.0.0.1:$UnguardedPort"
$guarded = "http://127.0.0.1:$GuardedPort"
$jobs = @()

function Invoke-Probe {
  param([string[]]$ProbeArgs)
  Push-Location (Join-Path $root 'probe')
  try {
    & python -m proofplane_probe.cli --catalog (Join-Path $root 'catalog') @ProbeArgs
    if ($LASTEXITCODE -ne 0) { throw "probe step failed: $($ProbeArgs -join ' ')" }
  } finally { Pop-Location }
}

function Wait-ForTarget {
  param([string]$Url, [string]$Name)
  for ($i = 0; $i -lt 50; $i++) {
    try { Invoke-RestMethod "$Url/healthz" -TimeoutSec 2 | Out-Null; return } catch { Start-Sleep -Milliseconds 200 }
  }
  throw "$Name did not become healthy at $Url"
}

try {
  Write-Host '==> building target'
  Push-Location (Join-Path $root 'target')
  try {
    & npm run build --silent
    if ($LASTEXITCODE -ne 0) { throw 'target build failed' }
  } finally { Pop-Location }

  Write-Host '==> starting targets'
  $targetDir = Join-Path $root 'target'
  $jobs += Start-Job -ScriptBlock {
    param($dir, $port)
    Set-Location $dir; $env:PROOFPLANE_GUARDRAILS = 'none'; $env:PORT = $port; node dist/server.js
  } -ArgumentList $targetDir, $UnguardedPort
  $jobs += Start-Job -ScriptBlock {
    param($dir, $port)
    Set-Location $dir; $env:PROOFPLANE_GUARDRAILS = 'all'; $env:PORT = $port; node dist/server.js
  } -ArgumentList $targetDir, $GuardedPort

  Wait-ForTarget $unguarded 'unguarded target'
  Wait-ForTarget $guarded 'guarded target'

  $ts = if ($RunTimestamp) { @('--run-timestamp', $RunTimestamp) } else { @() }

  Write-Host "`n==> step 1/9  catalog snapshot"
  # The catalog is authored in YAML and parsed by the probe, which validates threat identifiers
  # and constrains crosswalk confidence. Emitting the JSON snapshot here means the operator reads
  # a view that has already been through that validation, rather than reimplementing it.
  Invoke-Probe @('catalog', '--json', (Join-Path $root 'catalog/catalog.json'))

  Write-Host "`n==> step 2/9  AI surface discovery"
  # Discovery runs first because every control below is scoped to a model identifier, and
  # something has to establish which identifiers are in play before the scoping means anything.
  if (Get-Command go -ErrorAction SilentlyContinue) {
    Push-Location (Join-Path $root 'discover')
    try {
      & go run . --root $root --declared (Join-Path $root 'catalog/declared-ai.txt') `
        --out (Join-Path $evidence 'aibom.json') --format text --fail-on-undeclared
      if ($LASTEXITCODE -ne 0) { throw 'AI surface discovery failed' }
    } finally { Pop-Location }
  } else {
    Write-Host '  SKIPPED: no Go toolchain on PATH. The AI inventory is not being produced, so'
    Write-Host '  nothing below is scoped to a verified model identifier. See discover/README.md.'
  }

  Write-Host "`n==> step 3/9  falsifiability"
  Invoke-Probe @('verify', '--vulnerable', $unguarded, '--hardened', $guarded, '--trials', '1')

  Write-Host "`n==> step 4/9  independence"
  Invoke-Probe (@('matrix', '--target', $guarded, '--out', (Join-Path $evidence 'matrix.json')) + $ts)

  Write-Host "`n==> step 5/9  assessment"
  foreach ($pair in @(@('unguarded', $unguarded), @('guarded', $guarded))) {
    $name, $url = $pair
    Write-Host "`n--- $name ---"
    $outDir = Join-Path $evidence $name
    Invoke-Probe (@('run', '--target', $url, '--out', $outDir,
                    '--run-id', "$RunId-$name", '--trials', $Trials) + $ts)
    Invoke-Probe @('report', '--evidence', (Join-Path $outDir 'evidence.json'),
                   '--matrix', (Join-Path $evidence 'matrix.json'),
                   '--out', (Join-Path $outDir 'report.html'))
  }

  Write-Host "`n==> step 6/9  documented limitations"
  Invoke-Probe @('limits', '--target', $guarded, '--out', (Join-Path $evidence 'limits.json'))

  Write-Host "`n==> step 7/9  OSCAL schema validation"
  Push-Location $root
  try {
    & node scripts/validate-oscal.mjs
    if ($LASTEXITCODE -ne 0) { throw 'OSCAL validation failed' }
  } finally { Pop-Location }

  Write-Host "`n==> step 8/9  citation corroboration"
  Invoke-Probe @('corroborate', '--strict', '--out', (Join-Path $root 'catalog/corroboration/report.json'))

  Write-Host "`n==> step 9/9  loss exposure"
  # Last, because it prices what the run established and nothing else. A control is credited in
  # the loss model only if a probe executed an attack against it and the attack failed.
  Push-Location (Join-Path $root 'exposure')
  try {
    & npm run --silent build
    if ($LASTEXITCODE -ne 0) { throw 'exposure build failed' }
    & node dist/cli.js --root $root --out (Join-Path $evidence 'exposure.json') `
      --html (Join-Path $evidence 'exposure.html')
    if ($LASTEXITCODE -ne 0) { throw 'exposure run failed' }
  } finally { Pop-Location }

  Write-Host "`n==> done. evidence in $evidence"
} finally {
  foreach ($job in $jobs) { Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue }
}
