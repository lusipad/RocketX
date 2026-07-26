$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tauriRoot = Join-Path $repoRoot 'apps\desktop\src-tauri'
$config = Get-Content (Join-Path $tauriRoot 'tauri.conf.json') -Raw | ConvertFrom-Json
$version = [string]$config.version
$ocrRoot = Join-Path $tauriRoot 'target\ocr-resources\ocr'
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

Copy-Item -LiteralPath $slimInstaller.FullName -Destination $slimBackup -Force
Push-Location (Join-Path $repoRoot 'apps\desktop')
try {
  pnpm exec tauri bundle --bundles nsis --config src-tauri/tauri.full.conf.json --ci
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri full NSIS bundling failed with exit code $LASTEXITCODE"
  }
} catch {
  Move-Item -LiteralPath $slimBackup -Destination $slimInstaller.FullName -Force
  throw
} finally {
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
