# Start the on-premises service on Windows. Python, npm and a preinstalled
# Node.js are not required. The script picks a runtime and exits so SSH can return.
param([switch]$PlanOnly)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Fail([string]$Message) {
  [Console]::Error.WriteLine("nskit: $Message")
  exit 1
}

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

function Get-NodeMajor([string]$Bin) {
  if (-not (Test-Path -LiteralPath $Bin)) { return 0 }
  try {
    $ver = & $Bin -p "process.versions.node" 2>$null
    if (-not $ver) { return 0 }
    $text = @($ver)[0].ToString().Trim()
    $major = $text.Split(".")[0]
    $n = 0
    if (-not [int]::TryParse($major, [ref]$n)) { return 0 }
    return $n
  } catch {
    return 0
  }
}

function Get-BundledNode {
  $base = Join-Path (Split-Path -Parent $Root) "runtime"
  foreach ($name in @("node.exe", "node", "bin\node.exe", "bin\node")) {
    $path = Join-Path $base $name
    if (Test-Path -LiteralPath $path) { return (Resolve-Path -LiteralPath $path).Path }
  }
  return ""
}

function Get-SystemNode {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return "" }
  return $cmd.Source
}

function Test-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  & docker info 1>$null 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Emit([string]$Mode, [string]$Bin) {
  Write-Output $Mode
  Write-Output $Bin
}

Import-LaunchEnv (Join-Path $Root "launch.env")
if (-not $env:NSKIT_RUNTIME) { $env:NSKIT_RUNTIME = "auto" }
if (-not $env:NSKIT_SERVICE) { $env:NSKIT_SERVICE = "process" }
if (-not $env:NSKIT_HTTP_PORT) { $env:NSKIT_HTTP_PORT = "8080" }
if (-not $env:NSKIT_PUBLISH) { $env:NSKIT_PUBLISH = "0.0.0.0" }
if (-not $env:NSKIT_NODE_IMAGE) { $env:NSKIT_NODE_IMAGE = "node:22-bookworm-slim" }
if (-not $env:NSKIT_CONTAINER) { $env:NSKIT_CONTAINER = "nskit-platform" }
if (-not $env:NSKIT_DEPLOY_REDIS) { $env:NSKIT_DEPLOY_REDIS = "0" }
if (-not $env:NSKIT_DEPLOY_MINIO) { $env:NSKIT_DEPLOY_MINIO = "0" }

$script:Mode = "none"
$script:Bin = ""

function Select-Runtime {
  $runtime = $env:NSKIT_RUNTIME
  $bundled = Get-BundledNode
  $system = Get-SystemNode
  if ($runtime -eq "bundled") {
    if (-not $bundled) {
      Fail "runtime bundled: set options.node_binary to a Node.js 18+ executable built for this server. nskit does not download it. Python is not used."
    }
    $major = Get-NodeMajor $bundled
    if ($major -ge 18) { Emit "bundled" $bundled; return }
    if ($major -eq 0) {
      Fail "the Node binary in runtime/ does not run on this server. Pass a binary for this operating system and CPU as options.node_binary. Python is not used."
    }
    Fail "runtime bundled: Node.js 18 or newer is required."
  }
  if ($runtime -eq "system") {
    if (-not $system) {
      Fail "runtime system: Node.js 18+ is not on PATH. Install it, or set runtime: bundled or runtime: docker. Python is not required."
    }
    if ((Get-NodeMajor $system) -ge 18) { Emit "system" $system; return }
    Fail "runtime system: Node.js 18 or newer is required."
  }
  if ($runtime -eq "docker") {
    if (-not (Test-Docker)) {
      Fail "runtime docker: Docker is not available. Install Docker, or set runtime: bundled with options.node_binary. Node.js and Python are not required."
    }
    Emit "docker" ""
    return
  }
  if ($runtime -ne "auto") { Fail "options.runtime must be auto, system, bundled or docker" }
  if ($bundled -and (Get-NodeMajor $bundled) -ge 18) { Emit "bundled" $bundled; return }
  if ($system -and (Get-NodeMajor $system) -ge 18) { Emit "system" $system; return }
  if (Test-Docker) { Emit "docker" ""; return }
  Fail "nothing on this server can run the service. Use a Node.js 18+ binary (options.node_binary), Node.js 18+ on PATH, or Docker. Python, npm and a preinstalled runtime are not required."
}

if ($PlanOnly -or $args -contains "--plan") {
  Select-Runtime
  exit 0
}

$chosen = @(Select-Runtime)
$script:Mode = [string]$chosen[0]
$script:Bin = ""
if ($chosen.Length -gt 1) { $script:Bin = [string]$chosen[1] }

$App = Join-Path (Split-Path -Parent $Root) "app"
$Entry = Join-Path $App "index.js"
if (-not (Test-Path -LiteralPath $Entry)) {
  Fail "bundle entry is missing ($Entry). Package the service before starting it."
}
if (-not (Test-Path -LiteralPath (Join-Path $Root "data"))) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Root "data") | Out-Null
}

$env:NSKIT_PLATFORM = Join-Path $Root "platform.json"
$env:NSKIT_ENTRY = $Entry
$env:NSKIT_DATA_DIR = Join-Path $Root "data"
$env:NSKIT_PIDFILE = Join-Path $Root "supervisor.pid"

if ($env:NSKIT_STORAGE_DIR -and $script:Mode -ne "docker") {
  $storage = $env:NSKIT_STORAGE_DIR
  if (-not ($storage -match '^[A-Za-z]:' -or $storage.StartsWith("/") -or $storage.StartsWith("\"))) {
    $storage = Join-Path $Root $storage
  }
  $env:NSKIT_STORAGE_DIR = $storage
  if (-not (Test-Path -LiteralPath $storage)) { New-Item -ItemType Directory -Force -Path $storage | Out-Null }
}

if (($env:NSKIT_DEPLOY_REDIS -eq "1" -or $env:NSKIT_DEPLOY_MINIO -eq "1") -and $script:Mode -ne "docker") {
  Fail "Redis or MinIO containers need runtime docker on this server."
}
if ($env:NSKIT_SERVICE -eq "systemd") {
  Fail "service systemd is Linux only. On Windows the process is started in the background."
}
if ($env:NSKIT_SERVICE -ne "process") { Fail "options.service must be process or systemd" }

function Ensure-Image([string]$Image) {
  & docker image inspect $Image 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) { return }
  & docker pull $Image
  if ($LASTEXITCODE -ne 0) {
    Fail "Docker has no image $Image and could not pull it. Load the image on this server, or set runtime: bundled and options.node_binary. Python is not required."
  }
}

function Start-NskitNode([string]$NodeBin) {
  $pidFile = $env:NSKIT_PIDFILE
  if (Test-Path -LiteralPath $pidFile) {
    $old = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
    if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
  Set-Content -LiteralPath (Join-Path $Root "runtime.mode") -Value $script:Mode -Encoding ASCII
  $sup = Join-Path $Root "supervisor.mjs"
  if ($env:NSKIT_FOREGROUND -eq "1") {
    & $NodeBin $sup
    exit $LASTEXITCODE
  }
  $proc = Start-Process -FilePath $NodeBin -ArgumentList @("`"$sup`"") -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Root "supervisor.log") `
    -RedirectStandardError (Join-Path $Root "supervisor.err.log")
  Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ASCII
}

function Start-NskitDocker {
  $name = $env:NSKIT_CONTAINER
  $net = "$name-net"
  & docker network inspect $net 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { & docker network create $net 1>$null }
  if ($env:NSKIT_DEPLOY_REDIS -eq "1") {
    Ensure-Image $env:NSKIT_REDIS_IMAGE
    & docker rm -f "$name-redis" 1>$null 2>$null
    & docker run -d --name "$name-redis" --network $net --network-alias redis --restart unless-stopped $env:NSKIT_REDIS_IMAGE redis-server --save "" --appendonly no 1>$null
  }
  if ($env:NSKIT_DEPLOY_MINIO -eq "1") {
    Ensure-Image $env:NSKIT_MINIO_IMAGE
    & docker rm -f "$name-minio" 1>$null 2>$null
    & docker run -d --name "$name-minio" --network $net --network-alias minio --restart unless-stopped `
      -e "MINIO_ROOT_USER=$($env:NSKIT_MINIO_USER)" -e "MINIO_ROOT_PASSWORD=$($env:NSKIT_MINIO_PASSWORD)" `
      $env:NSKIT_MINIO_IMAGE server /data --console-address :9001 1>$null
  }
  Ensure-Image $env:NSKIT_NODE_IMAGE
  & docker rm -f $name 1>$null 2>$null
  $bind = "$($env:NSKIT_HTTP_PORT):$($env:NSKIT_HTTP_PORT)"
  if ($env:NSKIT_PUBLISH -match '^\d+\.\d+\.\d+\.\d+$' -and $env:NSKIT_PUBLISH -ne "0.0.0.0") {
    $bind = "$($env:NSKIT_PUBLISH):$bind"
  }
  $args = @(
    "run", "-d", "--name", $name, "--network", $net, "--network-alias", "platform", "--restart", "unless-stopped",
    "-p", $bind,
    "-e", "NSKIT_PLATFORM=/opt/nskit/platform/platform.json",
    "-e", "NSKIT_ENTRY=/opt/nskit/app/index.js",
    "-e", "NSKIT_DATA_DIR=/var/lib/nskit",
    "-v", "${App}:/opt/nskit/app:ro",
    "-v", "${Root}:/opt/nskit/platform:ro",
    "-v", "$($env:NSKIT_DATA_DIR):/var/lib/nskit"
  )
  if ($env:NSKIT_STORAGE_DIR) {
    $mount = $env:NSKIT_STORAGE_DIR
    if (-not ($mount -match '^[A-Za-z]:' -or $mount.StartsWith("/") -or $mount.StartsWith("\"))) {
      $mount = Join-Path $Root $mount
    }
    $args += @("-v", "${mount}:/var/lib/nskit/objects")
  }
  $args += @($env:NSKIT_NODE_IMAGE, "node", "/opt/nskit/platform/supervisor.mjs")
  & docker @args
  if ($LASTEXITCODE -ne 0) { Fail "docker run failed for $name" }
  Set-Content -LiteralPath (Join-Path $Root "runtime.mode") -Value "docker" -Encoding ASCII
}

if ($script:Mode -eq "docker") { Start-NskitDocker } else { Start-NskitNode $script:Bin }
