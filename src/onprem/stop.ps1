# Stop a service started by start.ps1. Python is not used.
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Import-LaunchEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $line = $line.TrimEnd("`r")
    if ($line -eq "" -or $line.StartsWith("#")) { continue }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { continue }
    $key = $line.Substring(0, $eq)
    if ($key -notmatch '^[A-Z0-9_]+$') { continue }
    $val = $line.Substring($eq + 1)
    if ($val.Length -ge 2 -and $val.StartsWith('"') -and $val.EndsWith('"')) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    Set-Item -Path "Env:$key" -Value $val
  }
}

Import-LaunchEnv (Join-Path $Root "launch.env")
if (-not $env:NSKIT_CONTAINER) { $env:NSKIT_CONTAINER = "nskit-platform" }
if (-not $env:NSKIT_DEPLOY_REDIS) { $env:NSKIT_DEPLOY_REDIS = "0" }
if (-not $env:NSKIT_DEPLOY_MINIO) { $env:NSKIT_DEPLOY_MINIO = "0" }

$mode = "process"
$modeFile = Join-Path $Root "runtime.mode"
if (Test-Path -LiteralPath $modeFile) {
  $mode = (Get-Content -LiteralPath $modeFile -TotalCount 1).Trim()
}

if ($mode -eq "docker") {
  & docker rm -f $env:NSKIT_CONTAINER 1>$null 2>$null
  if ($env:NSKIT_DEPLOY_REDIS -eq "1") { & docker rm -f "$($env:NSKIT_CONTAINER)-redis" 1>$null 2>$null }
  if ($env:NSKIT_DEPLOY_MINIO -eq "1") { & docker rm -f "$($env:NSKIT_CONTAINER)-minio" 1>$null 2>$null }
} else {
  $pidFile = Join-Path $Root "supervisor.pid"
  if (Test-Path -LiteralPath $pidFile) {
    $old = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
    if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}
if (Test-Path -LiteralPath $modeFile) { Remove-Item -LiteralPath $modeFile -Force -ErrorAction SilentlyContinue }
