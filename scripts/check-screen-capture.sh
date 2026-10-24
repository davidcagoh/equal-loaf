#!/usr/bin/env bash
set -euo pipefail

duration="${1:-2}"
if ! [[ "$duration" =~ ^[0-9]+$ ]] || (( duration < 1 || duration > 5 )); then
  printf 'Usage: %s [duration_seconds: 1..5]\n' "$0" >&2
  exit 2
fi

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/boson-screen-check.XXXXXX")"
capture_file="$temporary_dir/check.mov"
trap 'python3 -c '\''import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)'\'' "$temporary_dir"' EXIT

if ! perl -e 'alarm 8; exec @ARGV' screencapture -V "$duration" -x "$capture_file"; then
  printf 'macOS screen-only capture failed. Check System Settings > Privacy & Security > Screen Recording and allow the terminal app, then quit and reopen it.\n' >&2
  exit 1
fi

if [[ ! -s "$capture_file" ]]; then
  printf 'macOS screen-only capture returned without creating a video. Check Screen Recording permission for this terminal app.\n' >&2
  exit 1
fi

printf 'Screen-only capture succeeded; temporary video will be removed. No audio input was requested.\n'
