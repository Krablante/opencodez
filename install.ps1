param(
  [string]$Repository = $(if ($env:OPENCODEZ_UPDATE_REPOSITORY) { $env:OPENCODEZ_UPDATE_REPOSITORY } else { "Krablante/opencodez" }),
  [string]$InstallDir = $env:OPENCODEZ_INSTALL_DIR,
  [switch]$NoPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "install.ps1 is for Windows. Use install.sh on Linux or macOS."
}

if (-not $InstallDir) {
  if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is not set. Set OPENCODEZ_INSTALL_DIR and run again."
  }
  $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\OpenCodez\bin"
}

$ProcessorArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
  $env:PROCESSOR_ARCHITEW6432
} else {
  $env:PROCESSOR_ARCHITECTURE
}

$Arch = switch ($ProcessorArchitecture.ToLowerInvariant()) {
  { $_ -in @("amd64", "x86_64") } { "x64"; break }
  { $_ -in @("arm64", "aarch64") } { "arm64"; break }
  default { throw "Unsupported architecture: $ProcessorArchitecture" }
}

$InstallDir = [System.Environment]::ExpandEnvironmentVariables($InstallDir)
$Baseline = ""
if ($Arch -eq "x64") {
  try {
    Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);' -Name Kernel32 -Namespace OpenCodezInstaller
    if (-not [OpenCodezInstaller.Kernel32]::IsProcessorFeaturePresent(40)) {
      $Baseline = "-baseline"
    }
  } catch {
    # Unknown CPU capability must choose the broadly compatible artifact.
    $Baseline = "-baseline"
  }
}
$Asset = "opencodez-windows-$Arch$Baseline.zip"
$Url = "https://github.com/$Repository/releases/latest/download/$Asset"
$Work = Join-Path ([System.IO.Path]::GetTempPath()) "opencodez-install-$([System.Guid]::NewGuid().ToString("N"))"
$Archive = Join-Path $Work $Asset

function Add-UserPath {
  param([string]$Directory)

  $CurrentPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $Normalized = $Directory.TrimEnd("\")
  $Entries = @()

  if ($CurrentPath) {
    $Entries = $CurrentPath -split ";" | Where-Object { $_ }
  }

  if ($Entries | Where-Object { $_.TrimEnd("\") -ieq $Normalized }) {
    return $false
  }

  $NextPath = if ($CurrentPath) { "$CurrentPath;$Directory" } else { $Directory }
  [System.Environment]::SetEnvironmentVariable("Path", $NextPath, "User")
  return $true
}

function Add-ProcessPath {
  param([string]$Directory)

  $Normalized = $Directory.TrimEnd("\")
  $Entries = @()

  if ($env:Path) {
    $Entries = $env:Path -split ";" | Where-Object { $_ }
  }

  if ($Entries | Where-Object { $_.TrimEnd("\") -ieq $Normalized }) {
    return
  }

  $env:Path = if ($env:Path) { "$env:Path;$Directory" } else { $Directory }
}

try {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  New-Item -ItemType Directory -Force -Path $Work | Out-Null

  $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers @{
    Accept = "application/vnd.github+json"
    "User-Agent" = "opencodez-installer"
  }
  $ExpectedVersion = ([string]$Release.tag_name).TrimStart("v")
  if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+\+opencodez\.\d+$') {
    throw "Refusing non-production OpenCodez release version: $ExpectedVersion"
  }

  $ProgressPreference = "SilentlyContinue"
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing

  Expand-Archive -Path $Archive -DestinationPath $Work -Force

  $Binary = Join-Path $Work "opencodez.exe"
  if (-not (Test-Path $Binary)) {
    $Match = Get-ChildItem -Path $Work -Recurse -Filter "opencodez.exe" | Select-Object -First 1
    if (-not $Match) {
      throw "Archive did not contain opencodez.exe"
    }
    $Binary = $Match.FullName
  }

  $ActualVersion = ((& $Binary --version 2>&1) | Out-String).Trim().TrimStart("v")
  if ($LASTEXITCODE -ne 0 -or $ActualVersion -ne $ExpectedVersion) {
    throw "Downloaded binary reports '$ActualVersion'; expected production version '$ExpectedVersion'"
  }

  Copy-Item -Path $Binary -Destination (Join-Path $InstallDir "opencodez.exe") -Force

  if ($NoPath) {
    Write-Host "Installed $InstallDir\opencodez.exe"
    Write-Host "Add $InstallDir to PATH manually, or run without -NoPath."
    return
  }

  Add-ProcessPath $InstallDir

  if (Add-UserPath $InstallDir) {
    Write-Host "Installed $InstallDir\opencodez.exe"
    Write-Host "Added $InstallDir to your user PATH. You can run opencodez in this PowerShell window now."
    return
  }

  Write-Host "Installed $InstallDir\opencodez.exe"
  Write-Host "$InstallDir is already in your user PATH."
} finally {
  Remove-Item -Recurse -Force -Path $Work -ErrorAction SilentlyContinue
}
