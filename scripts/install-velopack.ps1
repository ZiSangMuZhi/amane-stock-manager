param(
  [string]$SetupPath = "",
  [string]$InstallTo = "",
  [switch]$Silent
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$AppFolderName = "Amane Stock Manager"

function Get-SetupPath {
  param([string]$RequestedPath)

  if (![string]::IsNullOrWhiteSpace($RequestedPath)) {
    $resolved = Resolve-Path -LiteralPath $RequestedPath -ErrorAction Stop
    return $resolved.ProviderPath
  }

  $candidate = Get-ChildItem -LiteralPath (Join-Path $Root "Releases") -Filter "*Setup*.exe" -File -ErrorAction Stop |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (!$candidate) {
    throw "No Velopack Setup.exe was found in Releases. Build it with scripts/package-velopack.ps1 first."
  }

  return $candidate.FullName
}

function Normalize-InstallDirectory {
  param([string]$RawPath)

  if ([string]::IsNullOrWhiteSpace($RawPath)) {
    return Join-Path $env:LOCALAPPDATA $AppFolderName
  }

  $trimmed = $RawPath.Trim().Trim('"')
  if ($trimmed -match '^[A-Za-z]:$') {
    $trimmed = "$trimmed\"
  }

  $fullPath = [System.IO.Path]::GetFullPath($trimmed)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  $normalizedFullPath = $fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $normalizedRoot = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)

  if ($normalizedFullPath.Equals($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return Join-Path $root $AppFolderName
  }

  return $fullPath
}

$ResolvedSetup = Get-SetupPath $SetupPath
$ResolvedInstallTo = Normalize-InstallDirectory $InstallTo
New-Item -ItemType Directory -Force -Path $ResolvedInstallTo | Out-Null

Write-Host "Setup: $ResolvedSetup"
Write-Host "Install directory: $ResolvedInstallTo"

if ([System.IO.Path]::GetExtension($ResolvedSetup).Equals(".msi", [System.StringComparison]::OrdinalIgnoreCase)) {
  $MsiArgs = @("/i", $ResolvedSetup, "VELOPACK_INSTALLDIR=$ResolvedInstallTo")
  if ($Silent) {
    $MsiArgs += @("/qn")
  }
  & msiexec.exe @MsiArgs
} else {
  $SetupArgs = @("--installto", $ResolvedInstallTo)
  if ($Silent) {
    $SetupArgs = @("--silent") + $SetupArgs
  }
  & $ResolvedSetup @SetupArgs
}
