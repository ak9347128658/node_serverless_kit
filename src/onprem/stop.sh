#!/bin/sh
# Stop a service started by start.sh. A POSIX shell is enough. Python is not used.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cr=$(printf '\r')
nl='
'

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

load_env "$ROOT/launch.env"

CONTAINER=${NSKIT_CONTAINER:-nskit-platform}
DEPLOY_REDIS=${NSKIT_DEPLOY_REDIS:-0}
DEPLOY_MINIO=${NSKIT_DEPLOY_MINIO:-0}
SYSTEMD_SCOPE=${NSKIT_SYSTEMD_SCOPE:-user}
MODE=process
if [ -f "$ROOT/runtime.mode" ]; then
  MODE=$(cat "$ROOT/runtime.mode" 2>/dev/null || true)
  MODE=${MODE%"$cr"}
  MODE=${MODE%%"$nl"*}
fi

case "$MODE" in
  docker)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if [ "$DEPLOY_REDIS" = "1" ]; then docker rm -f "${CONTAINER}-redis" >/dev/null 2>&1 || true; fi
    if [ "$DEPLOY_MINIO" = "1" ]; then docker rm -f "${CONTAINER}-minio" >/dev/null 2>&1 || true; fi
    ;;
  systemd)
    unit="nskit-${CONTAINER}.service"
    if [ "$SYSTEMD_SCOPE" = "system" ]; then
      sudo -n systemctl disable --now "$unit" >/dev/null 2>&1 || true
    else
      systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
    fi
    ;;
  *)
    if [ -f "$ROOT/supervisor.pid" ]; then
      pid=$(cat "$ROOT/supervisor.pid" 2>/dev/null || true)
      pid=${pid%"$cr"}
      if [ -n "${pid:-}" ]; then kill "$pid" 2>/dev/null || true; fi
      rm -f "$ROOT/supervisor.pid"
    fi
    ;;
esac
rm -f "$ROOT/runtime.mode"
