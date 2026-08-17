<#
.SYNOPSIS
  Regenerate a README screenshot from a real run.

.DESCRIPTION
  The README's screenshots are not decoration — they are the reports the pipeline actually
  produces, so they have to be regenerable by anyone who clones this. Run scripts/assure.ps1
  first (and, for the exposure report, exposure/dist/cli.js); this serves evidence/ and captures
  the chosen report with headless Chrome.

  -Report assurance  evidence/<configuration>/report.html -> docs/images/assurance-report.png
  -Report exposure   evidence/exposure.html               -> docs/images/exposure-report.png

  Height is a full-page height, not a crop: Chrome captures the window, so anything below the
  fold is simply absent. For assurance it is chosen so the whole 12x12 independence matrix lands
  in frame — if controls are added, raise it rather than cropping the matrix, because a partial
  diagonal proves nothing. For exposure it has to reach past the generic-loss-type cross-check at
  the foot of the page; a capture that stops above it shows the priced answer without the
  yardstick held against it, which is the wrong half.
#>
[CmdletBinding()]
param(
  [ValidateSet('assurance', 'exposure')]
  [string]$Report = 'assurance',
  [int]$Port = 8090,
  [int]$Width = 1400,
  [int]$Height = 0,
  [int]$Scale = 2,
  [string]$Configuration = 'guarded'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path $root 'evidence'

if ($Report -eq 'exposure') {
  $relative = 'exposure.html'
  $out = Join-Path $root 'docs/images/exposure-report.png'
  if ($Height -le 0) { $Height = 3260 }
  # The exposure report is nearly three times the height of the assurance one, and GitHub renders
  # a README image at roughly 900px wide regardless. At 1400 wide it is already oversampled for
  # display; capturing it at 2x as well quadruples the file for no visible gain. Pass -Scale 2
  # explicitly if you want it for something other than the README.
  if (-not $PSBoundParameters.ContainsKey('Scale')) { $Scale = 1 }
  $hint = 'run exposure/dist/cli.js first'
} else {
  $relative = "$Configuration/report.html"
  $out = Join-Path $root 'docs/images/assurance-report.png'
  if ($Height -le 0) { $Height = 1180 }
  $hint = 'run scripts/assure.ps1 first'
}

$source = Join-Path $evidence $relative
if (-not (Test-Path $source)) {
  throw "no report at $source — $hint"
}

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome not found' }

New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

$server = Start-Job -ScriptBlock {
  param($dir, $port)
  Set-Location $dir
  python -m http.server $port --bind 127.0.0.1
} -ArgumentList $evidence, $Port

try {
  for ($i = 0; $i -lt 40; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:$Port/$relative" -TimeoutSec 2 | Out-Null; break }
    catch { Start-Sleep -Milliseconds 250 }
  }

  # --window-size must be one quoted token. Unquoted, PowerShell splits on the comma and passes
  # two arguments, Chrome logs "Invalid --window-size specification ignored", and the capture
  # silently falls back to a default viewport — producing a small image that looks like a crop
  # rather than an error.
  & $chrome --headless=new --disable-gpu --hide-scrollbars "--force-device-scale-factor=$Scale" `
    "--window-size=$Width,$Height" --user-data-dir="$env:TEMP\proofplane-shot-profile" `
    --virtual-time-budget=4000 --screenshot="$out" `
    "http://127.0.0.1:$Port/$relative" | Out-Null

  if (-not (Test-Path $out)) { throw 'capture produced no file' }
  Write-Host "captured $out ($((Get-Item $out).Length) bytes)"
} finally {
  Stop-Job $server -ErrorAction SilentlyContinue
  Remove-Job $server -Force -ErrorAction SilentlyContinue
}
