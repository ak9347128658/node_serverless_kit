#!/bin/sh
# Start the on-premises service. A POSIX shell is enough: Python, npm and a
# preinstalled Node.js are not required. The script picks a runtime, starts
# the supervisor, and exits so a deploy over SSH can return.
set -eu

# Directory of this file, using only builtins. PATH may hide every directory
# that also contains node or docker, and those directories are where dirname lives.
script=$0
while :; do
  case $script in
    *\\*)
      next=${script%%\\*}/${script#*\\}
      [ "$next" != "$script" ] || break
      script=$next
      ;;
    *) break ;;
  esac
done
case $script in
  */*) script_dir=${script%/*} ;;
  *) script_dir=. ;;
esac
CDPATH= cd -- "$script_dir"
ROOT=$PWD
ENVFILE="$ROOT/launch.env"
PIDFILE="$ROOT/supervisor.pid"
MODEFILE="$ROOT/runtime.mode"
DATA="$ROOT/data"
cr=$(printf '\r')

load_env() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%"$cr"}
    case "$line" in
      ""|\#*) continue ;;
    esac
    key=${line%%=*}
    val=${line#*=}
    case "$key" in
      *[!A-Z0-9_]*) continue ;;
    esac
    case "$val" in
      \"*\")
        val=${val#\"}
        val=${val%\"}
        ;;
    esac
    export "$key=$val"
  done < "$1"
}

load_env "$ENVFILE"

RUNTIME=${NSKIT_RUNTIME:-auto}
SERVICE=${NSKIT_SERVICE:-process}
HTTP_PORT=${NSKIT_HTTP_PORT:-8080}
PUBLISH=${NSKIT_PUBLISH:-0.0.0.0}
NODE_IMAGE=${NSKIT_NODE_IMAGE:-node:22-bookworm-slim}
REDIS_IMAGE=${NSKIT_REDIS_IMAGE:-redis:7-alpine}
MINIO_IMAGE=${NSKIT_MINIO_IMAGE:-minio/minio:RELEASE.2025-04-22T22-12-26Z}
DEPLOY_REDIS=${NSKIT_DEPLOY_REDIS:-0}
DEPLOY_MINIO=${NSKIT_DEPLOY_MINIO:-0}
CONTAINER=${NSKIT_CONTAINER:-nskit-platform}
SYSTEMD_SCOPE=${NSKIT_SYSTEMD_SCOPE:-user}
SERVICE_NAME=${NSKIT_SERVICE_NAME:-nskit}
STAGE=${NSKIT_STAGE:-dev}
PLAN=0
if [ "${1:-}" = "--plan" ]; then PLAN=1; fi

fail() {
  printf 'nskit: %s\n' "$1" >&2
  exit 1
}

node_major() {
  ver=$("$1" -p "process.versions.node" 2>/dev/null) || ver=""
  maj=${ver%%.*}
  case "$maj" in
    ""|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$maj" ;;
  esac
}

bundled_path() {
  if [ -f "$ROOT/../runtime/node" ]; then printf '%s' "$ROOT/../runtime/node"; return 0; fi
  if [ -f "$ROOT/../runtime/bin/node" ]; then printf '%s' "$ROOT/../runtime/bin/node"; return 0; fi
  return 1
}

emit() {
  printf '%s\n%s\n' "$1" "${2:-}"
}

choose() {
  case "$RUNTIME" in
    bundled)
      path=$(bundled_path) || path=""
      if [ -z "$path" ]; then
        fail "runtime bundled: set options.node_binary to a Node.js 18+ executable built for this server. nskit does not download it. Python is not used."
      fi
      maj=$(node_major "$path")
      if [ "$maj" -ge 18 ]; then emit bundled "$path"; return 0; fi
      if [ "$maj" -eq 0 ]; then
        fail "the Node binary in runtime/ does not run on this server. Pass a binary for this operating system and CPU as options.node_binary. Python is not used."
      fi
      fail "runtime bundled: Node.js 18 or newer is required."
      ;;
    system)
      if ! command -v node >/dev/null 2>&1; then
        fail "runtime system: Node.js 18+ is not on PATH. Install it, or set runtime: bundled or runtime: docker. Python is not required."
      fi
      path=$(command -v node)
      maj=$(node_major "$path")
      if [ "$maj" -ge 18 ]; then emit system "$path"; return 0; fi
      fail "runtime system: Node.js 18 or newer is required."
      ;;
    docker)
      if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
        fail "runtime docker: Docker is not available. Install Docker, or set runtime: bundled with options.node_binary. Node.js and Python are not required."
      fi
      emit docker ""
      ;;
    auto)
      path=$(bundled_path) || path=""
      if [ -n "$path" ]; then
        maj=$(node_major "$path")
        if [ "$maj" -ge 18 ]; then emit bundled "$path"; return 0; fi
      fi
      if command -v node >/dev/null 2>&1; then
        path=$(command -v node)
        maj=$(node_major "$path")
        if [ "$maj" -ge 18 ]; then emit system "$path"; return 0; fi
      fi
      if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        emit docker ""
        return 0
      fi
      fail "nothing on this server can run the service. Use a Node.js 18+ binary (options.node_binary), Node.js 18+ on PATH, or Docker. Python, npm and a preinstalled runtime are not required."
      ;;
    *)
      fail "options.runtime must be auto, system, bundled or docker"
      ;;
  esac
}

if [ "$PLAN" -eq 1 ]; then
  choose
  exit 0
fi

if [ -d "$ROOT/../app" ]; then
  APP=$(CDPATH= cd -- "$ROOT/../app" && pwd)
else
  APP="$ROOT/../app"
fi
if [ ! -f "$APP/index.js" ]; then
  fail "bundle entry is missing ($APP/index.js). Package the service before starting it."
fi
mkdir -p "$DATA"

nl='
'
choice=$(choose) || exit 1
mode=${choice%%"$nl"*}
bin=${choice#*"$nl"}
bin=${bin%%"$nl"*}

export NSKIT_PLATFORM="$ROOT/platform.json"
export NSKIT_ENTRY="$APP/index.js"
export NSKIT_DATA_DIR="$DATA"
export NSKIT_PIDFILE="$PIDFILE"

# A relative dir: path is on the server, next to the platform files. An absolute
# path is used as given. Docker mounts that host path into the container.
if [ -n "${NSKIT_STORAGE_DIR:-}" ] && [ "$mode" != "docker" ]; then
  case "$NSKIT_STORAGE_DIR" in
    /*|[A-Za-z]:*) ;;
    *) NSKIT_STORAGE_DIR="$ROOT/$NSKIT_STORAGE_DIR" ;;
  esac
  export NSKIT_STORAGE_DIR
  mkdir -p "$NSKIT_STORAGE_DIR"
fi

if [ "$DEPLOY_REDIS" = "1" ] || [ "$DEPLOY_MINIO" = "1" ]; then
  if [ "$mode" != "docker" ]; then
    fail "Redis or MinIO containers need runtime docker on this server."
  fi
fi

ensure_image() {
  docker image inspect "$1" >/dev/null 2>&1 && return 0
  docker pull "$1" || fail "Docker has no image $1 and could not pull it. Load the image on this server, or set runtime: bundled and options.node_binary. Python is not required."
}

stop_pid() {
  if [ -f "$PIDFILE" ]; then
    old=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "${old:-}" ]; then
      kill "$old" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
}

start_node() {
  stop_pid
  printf '%s\n' "$mode" > "$MODEFILE"
  if [ "${NSKIT_FOREGROUND:-}" = "1" ]; then
    exec "$1" "$ROOT/supervisor.mjs"
  fi
  if command -v nohup >/dev/null 2>&1; then
    nohup "$1" "$ROOT/supervisor.mjs" >> "$ROOT/supervisor.log" 2>&1 &
  else
    "$1" "$ROOT/supervisor.mjs" >> "$ROOT/supervisor.log" 2>&1 &
  fi
  printf '%s\n' "$!" > "$PIDFILE"
}

write_unit() {
  node_bin=$1
  dest=$2
  {
    printf '%s\n' "[Unit]"
    printf '%s\n' "Description=nskit ${SERVICE_NAME} (${STAGE})"
    printf '%s\n' "After=network.target"
    printf '%s\n' "[Service]"
    printf '%s\n' "Type=simple"
    printf '%s\n' "WorkingDirectory=${ROOT}"
    printf '%s\n' "Environment=NSKIT_PLATFORM=${ROOT}/platform.json"
    printf '%s\n' "Environment=NSKIT_ENTRY=${APP}/index.js"
    printf '%s\n' "Environment=NSKIT_DATA_DIR=${DATA}"
    printf '%s\n' "ExecStart=\"${node_bin}\" \"${ROOT}/supervisor.mjs\""
    printf '%s\n' "Restart=on-failure"
    printf '%s\n' "[Install]"
    if [ "$SYSTEMD_SCOPE" = "system" ]; then
      printf '%s\n' "WantedBy=multi-user.target"
    else
      printf '%s\n' "WantedBy=default.target"
    fi
  } > "$dest"
}

start_systemd() {
  if [ "$mode" = "docker" ] || [ -z "$bin" ]; then
    fail "service systemd needs Node.js on the server (system or bundled). Docker cannot be the process systemd starts."
  fi
  unit="nskit-${CONTAINER}.service"
  if [ "$SYSTEMD_SCOPE" = "system" ]; then
    tmp="$ROOT/${unit}"
    write_unit "$bin" "$tmp"
    sudo -n cp "$tmp" "/etc/systemd/system/${unit}" || fail "systemd_scope system needs passwordless sudo to install /etc/systemd/system/${unit}."
    sudo -n systemctl daemon-reload || fail "systemctl daemon-reload failed."
    sudo -n systemctl enable --now "$unit" || fail "systemctl enable failed for ${unit}."
  else
    dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$dest"
    write_unit "$bin" "${dest}/${unit}"
    systemctl --user daemon-reload || fail "systemctl --user failed. Log in on the server, or set systemd_scope: system and allow passwordless sudo for systemctl."
    systemctl --user enable --now "$unit" || fail "systemctl --user enable failed for ${unit}."
  fi
  printf '%s\n' "systemd" > "$MODEFILE"
}

bind_spec() {
  case "$PUBLISH" in
    ""|0.0.0.0) printf '%s' "${HTTP_PORT}:${HTTP_PORT}" ;;
    *.*.*.*) printf '%s' "${PUBLISH}:${HTTP_PORT}:${HTTP_PORT}" ;;
    *) printf '%s' "${HTTP_PORT}:${HTTP_PORT}" ;;
  esac
}

start_docker() {
  net="${CONTAINER}-net"
  docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
  if [ "$DEPLOY_REDIS" = "1" ]; then
    ensure_image "$REDIS_IMAGE"
    docker rm -f "${CONTAINER}-redis" >/dev/null 2>&1 || true
    docker run -d --name "${CONTAINER}-redis" --network "$net" --network-alias redis --restart unless-stopped \
      "$REDIS_IMAGE" redis-server --save "" --appendonly no >/dev/null
  fi
  if [ "$DEPLOY_MINIO" = "1" ]; then
    ensure_image "$MINIO_IMAGE"
    docker rm -f "${CONTAINER}-minio" >/dev/null 2>&1 || true
    docker run -d --name "${CONTAINER}-minio" --network "$net" --network-alias minio --restart unless-stopped \
      -e "MINIO_ROOT_USER=${NSKIT_MINIO_USER:-nskit}" \
      -e "MINIO_ROOT_PASSWORD=${NSKIT_MINIO_PASSWORD:-}" \
      "$MINIO_IMAGE" server /data --console-address :9001 >/dev/null
  fi
  ensure_image "$NODE_IMAGE"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  set -- docker run -d --name "$CONTAINER" --network "$net" --network-alias platform --restart unless-stopped \
    -p "$(bind_spec)" \
    -e NSKIT_PLATFORM=/opt/nskit/platform/platform.json \
    -e NSKIT_ENTRY=/opt/nskit/app/index.js \
    -e NSKIT_DATA_DIR=/var/lib/nskit \
    -v "$APP:/opt/nskit/app:ro" \
    -v "$ROOT:/opt/nskit/platform:ro" \
    -v "$DATA:/var/lib/nskit"
  if [ -n "${NSKIT_STORAGE_DIR:-}" ]; then
    case "$NSKIT_STORAGE_DIR" in
      /*|[A-Za-z]:*) mount=$NSKIT_STORAGE_DIR ;;
      *) mount="$ROOT/$NSKIT_STORAGE_DIR" ;;
    esac
    set -- "$@" -v "${mount}:/var/lib/nskit/objects"
  fi
  set -- "$@" "$NODE_IMAGE" node /opt/nskit/platform/supervisor.mjs
  "$@" >/dev/null
  printf '%s\n' "docker" > "$MODEFILE"
}

case "$SERVICE" in
  systemd) start_systemd ;;
  process)
    case "$mode" in
      docker) start_docker ;;
      *) start_node "$bin" ;;
    esac
    ;;
  *) fail "options.service must be process or systemd" ;;
esac
