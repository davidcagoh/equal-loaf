#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly MC_VERSION="1.21.11"
readonly MC_CACHE_DIR="${BOSON_MC_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/boson/minecraft-${MC_VERSION}}"
readonly MC_PORT=25565
readonly GATEWAY_PORT=8001
readonly VIEWER_PORT="${BOSON_EXPLORER_VIEWER_PORT:-${BOSON_VIEWER_PORT:-3000}}"
readonly COMPANION_VIEWER_PORT="${BOSON_COMPANION_VIEWER_PORT:-3001}"
readonly PLAYER_NAME="${BOSON_MC_PLAYER:-DemoPlayer}"
readonly MIN_PLAYERS=5

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.6+ is required. Install it, then retry this command." >&2
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1)' || {
  echo "Node.js 22.6+ is required for TypeScript strip-types support." >&2
  exit 1
}
if [[ ! -d "$PROJECT_ROOT/packages/minecraft/node_modules/mineflayer" ]]; then
  echo "Minecraft dependencies are missing. Install them with npm ci --prefix packages/minecraft, then retry." >&2
  exit 1
fi
if [[ ! -f "$MC_CACHE_DIR/server-${MC_VERSION}.jar" ]]; then
  echo "Prepared Minecraft ${MC_VERSION} server is missing at $MC_CACHE_DIR. Prepare it explicitly with scripts/prepare-minecraft-world.sh." >&2
  exit 1
fi
if ! grep -qx 'eula=true' "$MC_CACHE_DIR/eula.txt" 2>/dev/null; then
  echo "Minecraft EULA is not already accepted in $MC_CACHE_DIR/eula.txt. Review and accept it yourself; this launcher does not change it." >&2
  exit 1
fi
if [[ ! "$VIEWER_PORT" =~ ^[0-9]+$ ]] || (( VIEWER_PORT < 1 || VIEWER_PORT > 65535 )); then
  echo "BOSON_EXPLORER_VIEWER_PORT must be a valid TCP port." >&2
  exit 1
fi
if [[ ! "$COMPANION_VIEWER_PORT" =~ ^[0-9]+$ ]] || (( COMPANION_VIEWER_PORT < 1 || COMPANION_VIEWER_PORT > 65535 )) || [[ "$VIEWER_PORT" == "$COMPANION_VIEWER_PORT" ]]; then
  echo "BOSON_COMPANION_VIEWER_PORT must be valid and differ from the explorer viewer port." >&2
  exit 1
fi
if [[ ! "$PLAYER_NAME" =~ ^[A-Za-z0-9_]{3,16}$ ]]; then
  echo "BOSON_MC_PLAYER must be a 3–16 character Minecraft username." >&2
  exit 1
fi

readonly JAVA_BIN="${JAVA_BIN:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["javaExecutable"])' "$MC_CACHE_DIR/boson-world.json")}"
for required_port in "$MC_PORT" "$GATEWAY_PORT" "$VIEWER_PORT" "$COMPANION_VIEWER_PORT"; do
  if nc -z -w 1 127.0.0.1 "$required_port" >/dev/null 2>&1; then
    echo "127.0.0.1:${required_port} is already in use. Stop the existing local service or select another BOSON_VIEWER_PORT." >&2
    exit 1
  fi
done

# Only adjust the local player capacity; preserve all other server settings and EULA state.
python3 - "$MC_CACHE_DIR/server.properties" "$MIN_PLAYERS" <<'PY'
from pathlib import Path
import sys

properties = Path(sys.argv[1])
minimum_players = int(sys.argv[2])
lines = properties.read_text(encoding="utf-8").splitlines()
values = {line.partition("=")[0]: line.partition("=")[2] for line in lines if "=" in line and not line.startswith("#")}
if values.get("server-ip") != "127.0.0.1":
    raise SystemExit("Minecraft server.properties must bind server-ip=127.0.0.1; refusing non-loopback launch.")
if values.get("online-mode") != "false":
    raise SystemExit("Minecraft server.properties must use online-mode=false for the local account-free demo.")
try:
    current_players = int(values.get("max-players", "0"))
except ValueError as error:
    raise SystemExit("Minecraft max-players must be an integer.") from error
if current_players < minimum_players:
    found = False
    for index, line in enumerate(lines):
        if line.startswith("max-players="):
            lines[index] = f"max-players={minimum_players}"
            found = True
            break
    if not found:
        lines.append(f"max-players={minimum_players}")
    properties.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Raised local max-players from {current_players} to {minimum_players}.")
else:
    print(f"Local player capacity is {current_players}.")
PY

readonly LOG_DIR="$MC_CACHE_DIR/boson-demo-logs"
mkdir -p "$LOG_DIR"
readonly RUN_ID="$(date +%Y%m%d-%H%M%S)"
readonly IPC_DIR="$(mktemp -d /tmp/bv.XXXXXX)"
chmod 700 "$IPC_DIR"
readonly IPC_SOCKET="$IPC_DIR/village.sock"
readonly SERVER_LOG="$LOG_DIR/server-${RUN_ID}.log"
readonly COMPANION_LOG="$LOG_DIR/companion-${RUN_ID}.log"
readonly EXPLORER_LOG="$LOG_DIR/explorer-${RUN_ID}.log"
readonly VILLAGE_LOG="$LOG_DIR/village-${RUN_ID}.log"
export BOSON_VILLAGE_IPC_SOCKET="$IPC_SOCKET"
child_pids=()
cleaning_up=false

job_running() {
  jobs -pr | awk -v target="$1" '$1 == target { found = 1 } END { exit !found }'
}

stop_children() {
  [[ "$cleaning_up" == true ]] && return
  cleaning_up=true
  trap - EXIT INT TERM
  local pid attempt running
  for pid in "${child_pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for attempt in {1..30}; do
    running=false
    for pid in "${child_pids[@]}"; do
      if job_running "$pid"; then running=true; break; fi
    done
    [[ "$running" == false ]] && break
    sleep 1
  done
  if [[ "$running" == true ]]; then
    echo "Some local processes are still stopping; sending KILL." >&2
    for pid in "${child_pids[@]}"; do job_running "$pid" && kill -KILL "$pid" 2>/dev/null || true; done
  fi
  for pid in "${child_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -rf "$IPC_DIR"
  echo "Boson village demo stopped; child processes have exited."
}

trap stop_children EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_log() {
  local pid="$1" file="$2" pattern="$3" label="$4" timeout="$5"
  local elapsed=0
  while (( elapsed < timeout )); do
    if rg -q "$pattern" "$file" 2>/dev/null; then
      echo "$label"
      return 0
    fi
    if ! job_running "$pid"; then
      echo "$label failed; last log output follows:" >&2
      tail -n 60 "$file" >&2 2>/dev/null || true
      return 1
    fi
    sleep 1
    ((elapsed += 1))
  done
  echo "Timed out waiting for $label; last log output follows:" >&2
  tail -n 60 "$file" >&2 2>/dev/null || true
  return 1
}

wait_for_http() {
  local pid="$1" url="$2" label="$3" timeout="$4"
  local elapsed=0
  while (( elapsed < timeout )); do
    if curl --fail --silent --show-error --max-time 1 "$url" >/dev/null 2>&1; then
      echo "$label"
      return 0
    fi
    if ! job_running "$pid"; then
      echo "$label failed; last log output follows:" >&2
      tail -n 60 "$COMPANION_LOG" >&2 2>/dev/null || true
      return 1
    fi
    sleep 1
    ((elapsed += 1))
  done
  echo "Timed out waiting for $label; last log output follows:" >&2
  tail -n 60 "$COMPANION_LOG" >&2 2>/dev/null || true
  return 1
}

cd "$PROJECT_ROOT"
export BOSON_MC_HOST=127.0.0.1
export BOSON_MC_PORT="$MC_PORT"
export BOSON_MC_PLAYER="$PLAYER_NAME"
export BOSON_VIEWER_PORT="$COMPANION_VIEWER_PORT"
export BOSON_EXPLORER_VIEWER_PORT="$VIEWER_PORT"
if [[ -z "${BOSON_PTT_ENV_FILE+x}" && -f "$PROJECT_ROOT/.env" ]]; then
  export BOSON_PTT_ENV_FILE="$PROJECT_ROOT/.env"
fi

node "$PROJECT_ROOT/packages/minecraft/scripts/apply-prismarine-viewer-fix.cjs"

echo "Starting loopback Minecraft ${MC_VERSION} with configured Java: $JAVA_BIN"
bash "$SCRIPT_DIR/start-minecraft-world.sh" >"$SERVER_LOG" 2>&1 &
server_pid=$!
child_pids+=("$server_pid")
wait_for_log "$server_pid" "$SERVER_LOG" 'Done \(' "Minecraft world ready on 127.0.0.1:${MC_PORT}" 180

node --experimental-strip-types packages/voice/src/server.ts >"$COMPANION_LOG" 2>&1 &
companion_pid=$!
child_pids+=("$companion_pid")
wait_for_log "$companion_pid" "$COMPANION_LOG" "Minecraft 3D viewer listening on http://127.0.0.1:${COMPANION_VIEWER_PORT}" "Companion ready" 60
wait_for_http "$companion_pid" "http://127.0.0.1:${COMPANION_VIEWER_PORT}/" "Companion viewer HTTP endpoint responds" 30
wait_for_http "$companion_pid" "http://127.0.0.1:${GATEWAY_PORT}/health" "Local companion gateway ready" 30

node --experimental-strip-types packages/minecraft/src/demo-player.ts >"$EXPLORER_LOG" 2>&1 &
explorer_pid=$!
child_pids+=("$explorer_pid")
wait_for_log "$explorer_pid" "$EXPLORER_LOG" "Account-free explorer ${PLAYER_NAME} spawned at" "Explorer spawned" 60
wait_for_log "$explorer_pid" "$EXPLORER_LOG" "Explorer viewer listening on http://127.0.0.1:${VIEWER_PORT}" "Explorer-attached viewer ready" 60
wait_for_http "$explorer_pid" "http://127.0.0.1:${VIEWER_PORT}/" "Explorer viewer HTTP endpoint responds" 30

node --experimental-strip-types scripts/run-village-with-dialogue-relay.mjs >"$VILLAGE_LOG" 2>&1 &
village_pid=$!
child_pids+=("$village_pid")
wait_for_log "$village_pid" "$VILLAGE_LOG" 'Village simulator active; forwarding dialogue' "Village simulator and dialogue relay ready" 30
wait_for_log "$village_pid" "$VILLAGE_LOG" 'MiraGardener .* joined at' "MiraGardener joined" 60
wait_for_log "$village_pid" "$VILLAGE_LOG" 'TobinCart .* joined at' "TobinCart joined" 60
wait_for_log "$village_pid" "$VILLAGE_LOG" 'PipBaker .* joined at' "PipBaker joined" 60
wait_for_log "$village_pid" "$VILLAGE_LOG" 'Relayed village dialogue event.' "First village dialogue event reached the viewer" 180

echo
echo "Village explorer is live: http://127.0.0.1:${VIEWER_PORT}/"
echo "Use the first-person controls to walk and look around. Hold Push to talk to address the nearest resident; audio is sent to Boson only while held."
echo "Runtime logs: $LOG_DIR (run $RUN_ID). Press Ctrl+C to stop the server and all demo processes."
while :; do
  for pid in "${child_pids[@]}"; do
    if ! job_running "$pid"; then
      echo "A demo process exited unexpectedly; check logs in $LOG_DIR." >&2
      exit 1
    fi
  done
  sleep 2
done
