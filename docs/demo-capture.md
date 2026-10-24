# Demo capture

Use `scripts/record-demo.sh [duration_seconds]` to capture the live flow in one unedited screen-and-microphone recording. The duration defaults to 90 seconds and must be between 60 and 90 seconds. The script requires an explicit Enter keypress before it opens the capture devices.

On the current Mac, AVFoundation device `1` is **Capture screen 0** and audio device `1` is **MacBook Air Microphone**. Override these with `BOSON_SCREEN_DEVICE` and `BOSON_MIC_DEVICE` if device ordering changes. The script captures the screen and microphone only; it does not capture desktop audio or upload the result. MP4 files are saved under the ignored local `recordings/` directory.

The capture helper requests AVFoundation's supported `uyvy422` screen pixel format explicitly. To check screen capture without opening the microphone or saving a video, run:

```sh
ffmpeg -hide_banner -f avfoundation -pixel_format uyvy422 -framerate 30 -capture_cursor 1 -capture_mouse_clicks 1 -i "1:none" -t 2 -f null -
```

Replace `1` with the current screen device ID if the device list changes. If the diagnostic reports an initialization error, do not start a microphone recording; resolve screen-capture permission or device selection first.

Before recording, keep the existing Boson Dry Run tab visible, reload it to pick up the current demo settings, confirm the viewer and adapter are ready, and mute unrelated audio. Start the capture, perform the spoken action and interruption, then let it finish or stop early with Ctrl+C. Keep the original clip as evidence; identify any edits or splices in a separate version and do not present them as uninterrupted behavior.
