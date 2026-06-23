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

if ([string]::IsNullOrWhiteSpace($UpdateChannel)) {
  throw "UpdateChannel cannot be empty."
}

if (![string]::IsNullOrWhiteSpace($GithubRepoUrl) -and [string]::IsNullOrWhiteSpace($UpdateUrl)) {
  $UpdateUrl = "$($GithubRepoUrl.TrimEnd('/'))/releases/latest/download/"
} elseif (![string]::IsNullOrWhiteSpace($UpdateUrl) -and $UpdateUrl.StartsWith("http", [System.StringComparison]::OrdinalIgnoreCase)) {
  $UpdateUrl = "$($UpdateUrl.TrimEnd('/'))/"
}

$env:AMANE_UPDATE_URL = $UpdateUrl
$env:AMANE_UPDATE_CHANNEL = $UpdateChannel

Write-Host "Building Electron package..."
npm run package:win

Write-Host "Restoring local Velopack CLI..."
dotnet tool restore

$PackDir = Join-Path $Root "dist-packaged\Amane Stock Manager-win32-x64"
$MainExe = "Amane Stock Manager.exe"
$MainExePath = Join-Path $PackDir $MainExe
if (!(Test-Path -LiteralPath $MainExePath)) {
  throw "Packaged executable not found: $MainExePath"
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
if ($CleanOutput -and (Test-Path -LiteralPath $OutputDir)) {
  $ResolvedRoot = [System.IO.Path]::GetFullPath($Root)
  $ResolvedOutput = [System.IO.Path]::GetFullPath($OutputDir)
  if (!$ResolvedOutput.StartsWith($ResolvedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      !([System.IO.Path]::GetFileName($ResolvedOutput).Equals("Releases", [System.StringComparison]::OrdinalIgnoreCase))) {
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
    Write-Warning "No prior GitHub release assets were downloaded. Continuing with local release files."
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

if (Test-Path -LiteralPath $ReleaseFeedPath) {
  foreach ($FeedName in $CompatibilityFeedNames) {
    $FeedPath = Join-Path $OutputDir $FeedName
    Copy-Item -LiteralPath $ReleaseFeedPath -Destination $FeedPath -Force
    $CompatibilityFeedPaths += $FeedPath
  }
}

if ($PublishGitHub) {
  if ([string]::IsNullOrWhiteSpace($GithubRepoUrl)) {
    throw "GithubRepoUrl is required when PublishGitHub is set."
  }
  if ([string]::IsNullOrWhiteSpace($GitHubToken)) {
    $GitHubToken = (& gh auth token 2>$null)
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
    & gh release upload $Tag @CompatibilityFeedPaths --repo $RepoSlug --clobber
    $UploadFeedsExitCode = $LASTEXITCODE
    $env:GH_TOKEN = $PreviousGhToken
    if ($UploadFeedsExitCode -ne 0) {
      throw "Compatibility feed upload failed with exit code $UploadFeedsExitCode"
    }
  }
}

Write-Host "Velopack output:"
Get-ChildItem -LiteralPath $OutputDir | Sort-Object LastWriteTime -Descending | Select-Object Name, Length, LastWriteTime
