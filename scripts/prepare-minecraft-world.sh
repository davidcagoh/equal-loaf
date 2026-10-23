#!/usr/bin/env bash
set -euo pipefail

readonly MC_VERSION="1.21.11"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly MC_CACHE_DIR="${BOSON_MC_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/boson/minecraft-${MC_VERSION}}"
readonly MANIFEST_URL="https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

resolve_executable() {
  local executable="$1"
  if [[ "$executable" == */* ]]; then
    [[ "$executable" == /* ]] || executable="$PWD/$executable"
    printf '%s\n' "$executable"
  else
    command -v "$executable"
  fi
}

resolve_java() {
  if [[ -n "${JAVA_BIN:-}" ]]; then
    resolve_executable "$JAVA_BIN" || {
      echo "JAVA_BIN does not resolve to an executable: ${JAVA_BIN}" >&2
      exit 1
    }
    return
  fi

  if command -v java >/dev/null 2>&1; then
    local system_java
    system_java="$(command -v java)"
    local system_major
    system_major="$("$system_java" -XshowSettings:properties -version 2>&1 | awk -F= '/java.specification.version/ { gsub(/[[:space:]]/, "", $2); print $2; exit }')"
    if [[ "$system_major" =~ ^[0-9]+$ ]] && (( system_major >= 21 )); then
      printf '%s\n' "$system_java"
      return
    fi
  fi

  if [[ -x /opt/homebrew/opt/openjdk@21/bin/java ]]; then
    printf '%s\n' /opt/homebrew/opt/openjdk@21/bin/java
    return
  fi

  echo "Java 21 or newer is required. Install it or set JAVA_BIN to its java executable." >&2
  exit 1
}

readonly JAVA_EXECUTABLE="$(resolve_java)"
readonly JAVA_MAJOR="$("$JAVA_EXECUTABLE" -XshowSettings:properties -version 2>&1 | awk -F= '/java.specification.version/ { gsub(/[[:space:]]/, "", $2); print $2; exit }')"
if [[ ! "$JAVA_MAJOR" =~ ^[0-9]+$ ]] || (( JAVA_MAJOR < 21 )); then
  echo "Minecraft ${MC_VERSION} requires Java 21 or newer; found Java ${JAVA_MAJOR:-unknown}." >&2
  exit 1
fi

mkdir -p "$MC_CACHE_DIR"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/boson-minecraft.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

curl --fail --location --silent --show-error "$MANIFEST_URL" --output "$temporary_dir/manifest.json"
version_url="$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print(next(v["url"] for v in data["versions"] if v["id"] == sys.argv[2]))' "$temporary_dir/manifest.json" "$MC_VERSION")"
curl --fail --location --silent --show-error "$version_url" --output "$temporary_dir/version.json"
server_url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["downloads"]["server"]["url"])' "$temporary_dir/version.json")"
expected_sha1="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["downloads"]["server"]["sha1"])' "$temporary_dir/version.json")"
server_jar="$MC_CACHE_DIR/server-${MC_VERSION}.jar"

if [[ ! -f "$server_jar" ]] || [[ "$(shasum -a 1 "$server_jar" | awk '{print $1}')" != "$expected_sha1" ]]; then
  curl --fail --location --silent --show-error --retry 3 "$server_url" --output "$temporary_dir/server.jar"
  actual_sha1="$(shasum -a 1 "$temporary_dir/server.jar" | awk '{print $1}')"
  if [[ "$actual_sha1" != "$expected_sha1" ]]; then
    echo "Mojang server jar checksum mismatch for ${MC_VERSION}." >&2
    exit 1
  fi
  command mv -f "$temporary_dir/server.jar" "$server_jar"
fi

if [[ ! -f "$MC_CACHE_DIR/server.properties" ]]; then
  command cp -f "$SCRIPT_DIR/../config/minecraft/server.properties" "$MC_CACHE_DIR/server.properties"
fi

if [[ ! -f "$MC_CACHE_DIR/eula.txt" ]]; then
  printf 'eula=false\n' > "$MC_CACHE_DIR/eula.txt"
fi

cat > "$MC_CACHE_DIR/boson-world.json" <<EOF
{
  "minecraftVersion": "${MC_VERSION}",
  "seed": "20261023",
  "serverJar": "$(basename "$server_jar")",
  "serverJarSha1": "${expected_sha1}",
  "javaExecutable": "${JAVA_EXECUTABLE}",
  "javaMajor": ${JAVA_MAJOR}
}
EOF

printf 'Prepared Minecraft Java %s in %s\n' "$MC_VERSION" "$MC_CACHE_DIR"
printf 'Server jar SHA-1 verified: %s\n' "$expected_sha1"
printf 'EULA acceptance is still required before the server can start. Review %s/eula.txt and the Minecraft EULA yourself.\n' "$MC_CACHE_DIR"
