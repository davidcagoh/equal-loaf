#!/usr/bin/env bash
set -euo pipefail

readonly MC_VERSION="1.21.11"
MC_CACHE_DIR="${BOSON_MC_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/boson/minecraft-${MC_VERSION}}"
mkdir -p "$MC_CACHE_DIR"
MC_CACHE_DIR="$(cd "$MC_CACHE_DIR" && pwd)"
readonly MC_CACHE_DIR
readonly SERVER_JAR="$MC_CACHE_DIR/server-${MC_VERSION}.jar"
readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "$SERVER_JAR" ]]; then
  echo "Minecraft server is not prepared. Run scripts/prepare-minecraft-world.sh first." >&2
  exit 1
fi

if ! grep -qx 'eula=true' "$MC_CACHE_DIR/eula.txt" 2>/dev/null; then
  echo "Minecraft server EULA has not been accepted. Review the EULA at https://aka.ms/MinecraftEULA and set eula=true in $MC_CACHE_DIR/eula.txt yourself." >&2
  exit 2
fi

# Stage the first-boot pack before Minecraft creates a fresh world. The pack
# sets the global spawn inside the pinned vanilla village; existing saves are
# left untouched and must be reset explicitly to adopt the new preset.
if [[ ! -f "$MC_CACHE_DIR/world/level.dat" ]]; then
  readonly VILLAGE_PACK="$PROJECT_ROOT/config/minecraft/world-packs/boson-village-spawn"
  if [[ ! -f "$VILLAGE_PACK/pack.mcmeta" ]]; then
    echo "Village spawn datapack is missing: $VILLAGE_PACK" >&2
    exit 1
  fi
  mkdir -p "$MC_CACHE_DIR/world/datapacks"
  command cp -rf "$VILLAGE_PACK" "$MC_CACHE_DIR/world/datapacks/"
fi

if [[ -n "${JAVA_BIN:-}" ]]; then
  if [[ "$JAVA_BIN" == */* ]]; then
    [[ "$JAVA_BIN" == /* ]] && java_bin="$JAVA_BIN" || java_bin="$PWD/$JAVA_BIN"
  else
    java_bin="$(command -v "$JAVA_BIN")"
  fi
else
  java_bin="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["javaExecutable"])' "$MC_CACHE_DIR/boson-world.json")"
  if [[ "$java_bin" != /* ]]; then
    if [[ "$java_bin" == */* ]]; then java_bin="$MC_CACHE_DIR/$java_bin"; else java_bin="$(command -v "$java_bin")"; fi
  fi
fi
java_major="$("$java_bin" -XshowSettings:properties -version 2>&1 | awk -F= '/java.specification.version/ { gsub(/[[:space:]]/, "", $2); print $2; exit }')"
if [[ ! "$java_major" =~ ^[0-9]+$ ]] || (( java_major < 21 )); then
  echo "Minecraft ${MC_VERSION} requires Java 21 or newer; JAVA_BIN resolved to Java ${java_major:-unknown}." >&2
  exit 1
fi
cd "$MC_CACHE_DIR"
exec "$java_bin" -Xms1G -Xmx2G -jar "$SERVER_JAR" nogui
