$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tauriRoot = Join-Path $repoRoot 'apps\desktop\src-tauri'
$config = Get-Content (Join-Path $tauriRoot 'tauri.conf.json') -Raw | ConvertFrom-Json
$version = [string]$config.version
$ocrRoot = Join-Path $tauriRoot 'target\ocr-resources\ocr'
$codexRoot = Join-Path $tauriRoot 'target\codex-resources\codex'
$dshArchive = Join-Path $tauriRoot 'target\dsh-runtime.tar.gz'
$nodeRoot = Join-Path $tauriRoot 'target\node-resources\node'
$nodeTarget = Join-Path $nodeRoot 'node.exe'
$nsisRoot = Join-Path $tauriRoot 'target\release\bundle\nsis'
$slimInstaller = Get-ChildItem -LiteralPath $nsisRoot -File |
  Where-Object { $_.Name -match "^RocketX_$([regex]::Escape($version))_.*-setup\.exe$" -and $_.Name -notmatch '_full-setup\.exe$' } |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if ($null -eq $slimInstaller) {
  throw "Slim RocketX $version NSIS installer must be built before the full setup"
}
$slimBackup = "$($slimInstaller.FullName).slim-backup"

if (-not (Test-Path -LiteralPath $ocrRoot -PathType Container)) {
  throw "Full setup OCR resource is missing: $ocrRoot"
}
if (-not (Test-Path -LiteralPath $dshArchive -PathType Leaf)) {
  throw "Full setup DSH archive is missing: $dshArchive"
}
if (-not (Test-Path -LiteralPath $codexRoot -PathType Container)) {
  pnpm -w run prepare:codex
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm prepare:codex failed with exit code $LASTEXITCODE"
  }
}
if (-not (Test-Path -LiteralPath $codexRoot -PathType Container)) {
  throw "Full setup Codex resource is missing: $codexRoot"
}
New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop |
  Select-Object -First 1
$nodeVersionText = (& $nodeCommand.Source --version).Trim().TrimStart('v')
if ($LASTEXITCODE -ne 0) {
  throw "Bundled Node version probe failed with exit code $LASTEXITCODE"
}
$nodeVersion = [version]$nodeVersionText
if (-not (($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 19) -or $nodeVersion.Major -ge 24)) {
  throw "Full setup requires Node.js 22.19+ or 24+, found v$nodeVersionText"
}
Copy-Item -LiteralPath $nodeCommand.Source -Destination $nodeTarget -Force

Copy-Item -LiteralPath $slimInstaller.FullName -Destination $slimBackup -Force
Push-Location (Join-Path $repoRoot 'apps\desktop')
$previousBundleOcr = [Environment]::GetEnvironmentVariable('ROCKETX_BUNDLE_OCR', 'Process')
[Environment]::SetEnvironmentVariable('ROCKETX_BUNDLE_OCR', '1', 'Process')
try {
  pnpm exec tauri bundle --bundles nsis --config src-tauri/tauri.full.conf.json --ci
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri full NSIS bundling failed with exit code $LASTEXITCODE"
  }
} catch {
  Move-Item -LiteralPath $slimBackup -Destination $slimInstaller.FullName -Force
  throw
} finally {
  [Environment]::SetEnvironmentVariable('ROCKETX_BUNDLE_OCR', $previousBundleOcr, 'Process')
  Pop-Location
}

$installer = Get-ChildItem -LiteralPath $nsisRoot -File |
  Where-Object { $_.Name -match "^RocketX_$([regex]::Escape($version))_.*-setup\.exe$" -and $_.Name -notmatch '_full-setup\.exe$' } |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if ($null -eq $installer) {
  throw "Tauri did not produce the RocketX $version NSIS installer"
}

$fullInstaller = Join-Path $nsisRoot "RocketX_${version}_full-setup.exe"
Move-Item -LiteralPath $installer.FullName -Destination $fullInstaller -Force
Move-Item -LiteralPath $slimBackup -Destination $slimInstaller.FullName -Force
Write-Output $fullInstaller
