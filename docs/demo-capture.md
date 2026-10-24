# Demo capture

Use `scripts/record-demo.sh [duration_seconds]` to capture the live flow in one unedited screen-and-microphone recording. The duration defaults to 90 seconds and must be between 60 and 90 seconds. The script requires an explicit Enter keypress before it opens the capture devices.

On the current Mac, AVFoundation device `1` is **Capture screen 0** and audio device `1` is **MacBook Air Microphone**. Override these with `BOSON_SCREEN_DEVICE` and `BOSON_MIC_DEVICE` if device ordering changes. The script captures the screen and microphone only; it does not capture desktop audio or upload the result. MP4 files are saved under the ignored local `recordings/` directory.

The capture helper requests AVFoundation's `uyvy422` screen pixel format explicitly. It gives FFmpeg 12 seconds to initialize and removes a partial output if initialization fails. A timeout usually means Screen Recording permission is missing for the terminal app or the screen device ID is stale. Open **System Settings > Privacy & Security > Screen Recording**, allow the terminal app, then quit and reopen it before retrying. Terminal cannot reliably inspect its own TCC permission state.

For a native macOS screen-only capture check, run the bounded helper below. It uses `screencapture -V` to record a two-second temporary MOV, requests no audio input, and removes the file afterward. This avoids AVFoundation's failing screen-device initialization path.

```sh
scripts/check-screen-capture.sh
```

The separate FFmpeg screen-only diagnostic remains available by setting `BOSON_CAPTURE_STARTUP_TIMEOUT=5` before the command, but it has hung on this Mac. Its AVFoundation input reached `<AVCaptureScreenInput> opened` but did not initialize within the bounded window, even with an explicit pixel format and a 720p/NV12 retry. The TCC database denied command-line inspection, so the exact permission grant state could not be confirmed. If the native helper fails, do not proceed to the screen-and-microphone recording; fix Screen Recording permission first.

Before recording, keep the existing Boson Dry Run tab visible, reload it to pick up the current demo settings, confirm the viewer and adapter are ready, and mute unrelated audio. Start the capture, perform the spoken action and interruption, then let it finish or stop early with Ctrl+C. Keep the original clip as evidence; identify any edits or splices in a separate version and do not present them as uninterrupted behavior.
