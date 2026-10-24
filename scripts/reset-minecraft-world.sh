#!/usr/bin/env bash
set -euo pipefail

readonly MC_VERSION="1.21.11"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly MC_CACHE_DIR="${BOSON_MC_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/boson/minecraft-${MC_VERSION}}"
readonly BACKUP_ROOT="$MC_CACHE_DIR/backups"

if [[ ! -f "$MC_CACHE_DIR/server-${MC_VERSION}.jar" ]]; then
  echo "Minecraft server is not prepared. Run scripts/prepare-minecraft-world.sh first." >&2
  exit 1
fi

if [[ ! -f "$MC_CACHE_DIR/server.properties" ]]; then
  echo "Missing server.properties; refusing to reset an unverified world directory." >&2
  exit 1
fi
server_port="$(awk -F= '$1 == "server-port" { print $2; exit }' "$MC_CACHE_DIR/server.properties")"
if [[ ! "$server_port" =~ ^[0-9]+$ ]] || (( server_port < 1 || server_port > 65535 )); then
  echo "Could not determine a valid Minecraft server-port; refusing to reset." >&2
  exit 1
fi

set +e
python3 - "$server_port" <<'PY'
import socket
import sys

try:
    with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=2):
        sys.exit(0)
except ConnectionRefusedError:
    sys.exit(1)
except OSError:
    sys.exit(2)
PY
port_status=$?
set -e
if [[ "$port_status" -eq 0 ]]; then
  echo "Minecraft is still listening on 127.0.0.1:${server_port}; stop it before resetting the world." >&2
  exit 1
elif [[ "$port_status" -ne 1 ]]; then
  echo "Could not verify whether Minecraft is running; refusing to reset." >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT"
world_dir="$MC_CACHE_DIR/world"
if [[ -d "$world_dir" ]]; then
  backup_dir="$(mktemp -d "$BACKUP_ROOT/world-$(date +%Y%m%d-%H%M%S).XXXXXX")"
  rmdir "$backup_dir"
  command mv "$world_dir" "$backup_dir"
  echo "Previous world backed up to $backup_dir"
fi

command cp -f "$SCRIPT_DIR/../config/minecraft/server.properties" "$MC_CACHE_DIR/server.properties"
echo "Restored the pinned Minecraft 1.21.11 plains-village settings (seed 244). Start the world with scripts/start-minecraft-world.sh."
