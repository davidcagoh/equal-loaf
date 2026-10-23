#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly RECORDING_DIR="$PROJECT_ROOT/recordings"

duration="${1:-90}"
screen_device="${BOSON_SCREEN_DEVICE:-1}"
microphone_device="${BOSON_MIC_DEVICE:-1}"

if ! [[ "$duration" =~ ^[0-9]+$ ]] || (( duration < 60 || duration > 90 )); then
  printf 'Usage: %s [duration_seconds: 60..90]\n' "$0" >&2
  exit 2
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  printf 'ffmpeg is required. Install it with Homebrew: brew install ffmpeg\n' >&2
  exit 1
fi

mkdir -p "$RECORDING_DIR"
output="$RECORDING_DIR/boson-demo-$(date +%Y%m%d-%H%M%S).mp4"
if [[ -e "$output" ]]; then
  printf 'Refusing to overwrite existing recording: %s\n' "$output" >&2
  exit 1
fi

printf 'Capture target: macOS screen device %s and microphone device %s\n' "$screen_device" "$microphone_device"
printf 'Duration: %s seconds\n' "$duration"
printf 'Output: %s\n' "$output"
printf 'Prepare the existing Boson Dry Run Chrome tab. Keep only intended demo content visible and mute unrelated audio.\n'
read -r -p 'Press Enter when you are ready to record; the microphone and screen will be captured immediately. '

ffmpeg -hide_banner \
  -f avfoundation \
  -framerate 30 \
  -capture_cursor 1 \
  -capture_mouse_clicks 1 \
  -i "${screen_device}:${microphone_device}" \
  -t "$duration" \
  -vf 'scale=1280:-2' \
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ar 48000 -ac 1 \
  -movflags +faststart \
  "$output"

printf 'Recording saved locally: %s\n' "$output"
printf 'Review the full clip before sharing. It is unedited screen and microphone capture.\n'
