$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tauriRoot = Join-Path $repoRoot 'apps\desktop\src-tauri'
$config = Get-Content (Join-Path $tauriRoot 'tauri.conf.json') -Raw | ConvertFrom-Json
$version = [string]$config.version
$codexRoot = Join-Path $tauriRoot 'target\codex-resources\codex'
$ocrRoot = Join-Path $tauriRoot 'target\ocr-resources\ocr'

foreach ($resourceRoot in @($codexRoot, $ocrRoot)) {
  if (-not (Test-Path -LiteralPath $resourceRoot -PathType Container)) {
    throw "Full setup resource is missing: $resourceRoot"
  }
}

Push-Location (Join-Path $repoRoot 'apps\desktop')
try {
  pnpm exec tauri bundle --bundles nsis --config src-tauri/tauri.full.conf.json --ci
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri full NSIS bundling failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$nsisRoot = Join-Path $tauriRoot 'target\release\bundle\nsis'
$installer = Get-ChildItem -LiteralPath $nsisRoot -File |
  Where-Object { $_.Name -match "^RocketX_$([regex]::Escape($version))_.*-setup\.exe$" -and $_.Name -notmatch '_full-setup\.exe$' } |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if ($null -eq $installer) {
  throw "Tauri did not produce the RocketX $version NSIS installer"
}

$fullInstaller = Join-Path $nsisRoot "RocketX_${version}_full-setup.exe"
Move-Item -LiteralPath $installer.FullName -Destination $fullInstaller -Force
Write-Output $fullInstaller
