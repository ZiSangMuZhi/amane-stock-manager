param(
  [string]$Version = "",
  [string]$Runtime = "win-x64",
  [string]$UpdateUrl = "",
  [string]$UpdateChannel = "win",
  [switch]$Msi,
  [ValidateSet("PerUser", "PerMachine", "Either")]
  [string]$InstallScope = "PerUser",
  [switch]$CleanOutput,
  [string]$GithubRepoUrl = "",
  [switch]$PublishGitHub,
  [string]$GitHubToken = "",
  [string]$ReleaseName = "",
  [string]$Tag = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Package = Get-Content -LiteralPath "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = $Package.version
}

if ($Version -notmatch '^\d+\.\d+\.\d+([\-+][0-9A-Za-z\.-]+)?$') {
  throw "Velopack requires a SemVer2 version such as 1.2.3. Received: $Version"
}

if ($Version -ne $Package.version) {
  throw "The release version must match package.json ($($Package.version)); update the application version before packaging."
}
if ($Runtime -ne "win-x64") {
  throw "package:win builds Windows x64; Runtime must be win-x64."
}

if ($UpdateChannel -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
  throw "UpdateChannel must be a simple channel name such as win."
}

if (![string]::IsNullOrWhiteSpace($GithubRepoUrl) -and [string]::IsNullOrWhiteSpace($UpdateUrl)) {
  $UpdateUrl = "$($GithubRepoUrl.TrimEnd('/'))/releases/latest/download/"
} elseif (![string]::IsNullOrWhiteSpace($UpdateUrl) -and $UpdateUrl.StartsWith("http", [System.StringComparison]::OrdinalIgnoreCase)) {
  $UpdateUrl = "$($UpdateUrl.TrimEnd('/'))/"
}

$env:AMANE_UPDATE_URL = $UpdateUrl
$env:AMANE_UPDATE_CHANNEL = $UpdateChannel

Write-Host "Building Electron package..."
$BuildStartedAt = [DateTime]::UtcNow
npm run package:win
if ($LASTEXITCODE -ne 0) {
  throw "Electron build/package failed with exit code $LASTEXITCODE; existing output will not be released."
}

Write-Host "Restoring local Velopack CLI..."
dotnet tool restore
if ($LASTEXITCODE -ne 0) {
  throw "Velopack CLI restore failed with exit code $LASTEXITCODE; packaging has stopped."
}

$PackDir = Join-Path $Root "dist-packaged\Amane Stock Manager-win32-x64"
$MainExe = "Amane Stock Manager.exe"
$MainExePath = Join-Path $PackDir $MainExe
if (!(Test-Path -LiteralPath $MainExePath)) {
  throw "Packaged executable not found: $MainExePath"
}
$ManifestPath = Join-Path $Root "dist-packaged\package-manifest.json"
if (!(Test-Path -LiteralPath $ManifestPath) -or (Get-Item -LiteralPath $ManifestPath).LastWriteTimeUtc -lt $BuildStartedAt) {
  throw "The current build did not produce a fresh audited package manifest."
}
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$PackagedPackage = Get-Content -LiteralPath (Join-Path $PackDir "resources\app\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Manifest.version -ne $Version -or $PackagedPackage.version -ne $Version) {
  throw "Packaged application metadata does not match release version $Version."
}

$UninstallerPath = Join-Path $PackDir "Uninstall Amane Stock Manager.cmd"
$UninstallerContent = @'
@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%Update.exe" (
  "%HERE%Update.exe" --uninstall
  exit /b %ERRORLEVEL%
)
if exist "%HERE%..\Update.exe" (
  "%HERE%..\Update.exe" --uninstall
  exit /b %ERRORLEVEL%
)
echo Velopack uninstaller was not found.
pause
exit /b 1
'@
Set-Content -LiteralPath $UninstallerPath -Value $UninstallerContent -Encoding ASCII

$OutputDir = Join-Path $Root "Releases"
# PowerShell 5 reports OneDrive cloud placeholders as ReparsePoint as well.
# Node checks links and real target paths without rejecting normal cloud files.
node (Join-Path $Root "scripts\package-win.mjs") --check-release-directory
if ($LASTEXITCODE -ne 0) {
  throw "Release output path verification failed with exit code $LASTEXITCODE."
}
if ($CleanOutput -and (Test-Path -LiteralPath $OutputDir)) {
  $ResolvedOutput = [System.IO.Path]::GetFullPath($OutputDir)
  $ExpectedOutput = [System.IO.Path]::GetFullPath((Join-Path $Root "Releases"))
  if (!$ResolvedOutput.Equals($ExpectedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean unexpected output directory: $ResolvedOutput"
  }
  Remove-Item -LiteralPath $ResolvedOutput -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if (![string]::IsNullOrWhiteSpace($GithubRepoUrl) -and !$CleanOutput) {
  $DownloadArgs = @(
    "tool", "run", "vpk", "download", "github",
    "--repoUrl", $GithubRepoUrl,
    "--outputDir", $OutputDir,
    "--channel", $UpdateChannel
  )
  if (![string]::IsNullOrWhiteSpace($GitHubToken)) {
    $DownloadArgs += @("--token", $GitHubToken)
  }
  Write-Host "Downloading latest GitHub release assets for delta generation..."
  & dotnet @DownloadArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Previous GitHub release download failed with exit code $LASTEXITCODE; no new release will be packed or uploaded."
  }
}

$VpkArgs = @(
  "tool", "run", "vpk", "pack",
  "--packId", "AmaneStockManager",
  "--packVersion", $Version,
  "--packDir", $PackDir,
  "--mainExe", $MainExe,
  "--packTitle", "Amane Stock Manager",
  "--packAuthors", "Amane",
  "--outputDir", $OutputDir,
  "--runtime", $Runtime,
  "--channel", $UpdateChannel
)

$IconPath = Join-Path $Root "assets\app.ico"
if (Test-Path -LiteralPath $IconPath) {
  $VpkArgs += @("--icon", $IconPath)
}

if ($Msi) {
  $VpkArgs += @("--msi", "--instLocation", $InstallScope)
}

Write-Host "Packing Velopack release $Version..."
$PackStartedAt = [DateTime]::UtcNow
& dotnet @VpkArgs
if ($LASTEXITCODE -ne 0) {
  throw "Velopack packaging failed with exit code $LASTEXITCODE"
}

$ReleaseFeedName = "releases.$UpdateChannel.json"
$ReleaseFeedPath = Join-Path $OutputDir $ReleaseFeedName
$CompatibilityFeedNames = @("releases.win-x64.json", "releases.stable.json", "releases.json") |
  Where-Object { $_ -ne $ReleaseFeedName } |
  Select-Object -Unique
$CompatibilityFeedPaths = @()

if (!(Test-Path -LiteralPath $ReleaseFeedPath) -or (Get-Item -LiteralPath $ReleaseFeedPath).LastWriteTimeUtc -lt $PackStartedAt) {
  throw "Velopack did not produce a fresh $ReleaseFeedName feed."
}
$ReleaseFeed = Get-Content -LiteralPath $ReleaseFeedPath -Raw -Encoding UTF8 | ConvertFrom-Json
$CurrentFull = @($ReleaseFeed.Assets | Where-Object { $_.PackageId -eq "AmaneStockManager" -and $_.Version -eq $Version -and $_.Type -eq "Full" })
if ($CurrentFull.Count -ne 1) {
  throw "The release feed must contain exactly one full AmaneStockManager package for $Version."
}
$FullAsset = $CurrentFull[0]
if ([System.IO.Path]::GetFileName($FullAsset.FileName) -ne $FullAsset.FileName -or $FullAsset.FileName -notmatch '\.nupkg$') {
  throw "The release feed contains an invalid package filename."
}
$FullPath = Join-Path $OutputDir $FullAsset.FileName
if (!(Test-Path -LiteralPath $FullPath) -or (Get-Item -LiteralPath $FullPath).Length -ne $FullAsset.Size -or
    (Get-FileHash -LiteralPath $FullPath -Algorithm SHA256).Hash -ne $FullAsset.SHA256) {
  throw "The release package size or SHA256 does not match the current feed."
}
foreach ($FeedName in $CompatibilityFeedNames) {
  $FeedPath = Join-Path $OutputDir $FeedName
  Copy-Item -LiteralPath $ReleaseFeedPath -Destination $FeedPath -Force
  $CompatibilityFeedPaths += $FeedPath
}

if ($PublishGitHub) {
  if ([string]::IsNullOrWhiteSpace($GithubRepoUrl)) {
    throw "GithubRepoUrl is required when PublishGitHub is set."
  }
  if ([string]::IsNullOrWhiteSpace($GitHubToken)) {
    $GitHubToken = (& gh auth token 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "Unable to obtain GitHub authentication for the release upload." }
  }
  if ([string]::IsNullOrWhiteSpace($GitHubToken)) {
    throw "GitHub token is required for Velopack GitHub upload. Pass -GitHubToken or run gh auth login."
  }
  if ([string]::IsNullOrWhiteSpace($ReleaseName)) {
    $ReleaseName = "Amane Stock Manager $Version"
  }
  if ([string]::IsNullOrWhiteSpace($Tag)) {
    $Tag = "v$Version"
  }

  $UploadArgs = @(
    "tool", "run", "vpk", "upload", "github",
    "--repoUrl", $GithubRepoUrl,
    "--outputDir", $OutputDir,
    "--releaseName", $ReleaseName,
    "--tag", $Tag,
    "--publish",
    "--merge",
    "--token", $GitHubToken
  )

  Write-Host "Uploading Velopack release to GitHub..."
  & dotnet @UploadArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Velopack GitHub upload failed with exit code $LASTEXITCODE"
  }

  if ($CompatibilityFeedPaths.Count -gt 0) {
    $RepoSlug = $GithubRepoUrl.TrimEnd('/') -replace '^https://github\.com/', '' -replace '\.git$', ''
    $PreviousGhToken = $env:GH_TOKEN
    if (![string]::IsNullOrWhiteSpace($GitHubToken)) {
      $env:GH_TOKEN = $GitHubToken
    }

    Write-Host "Uploading compatibility release feeds to GitHub..."
    try {
      & gh release upload $Tag @CompatibilityFeedPaths --repo $RepoSlug --clobber
      $UploadFeedsExitCode = $LASTEXITCODE
    } finally { $env:GH_TOKEN = $PreviousGhToken }
    if ($UploadFeedsExitCode -ne 0) {
      throw "Compatibility feed upload failed with exit code $UploadFeedsExitCode"
    }
  }
}

Write-Host "Velopack output:"
Get-ChildItem -LiteralPath $OutputDir | Sort-Object LastWriteTime -Descending | Select-Object Name, Length, LastWriteTime
