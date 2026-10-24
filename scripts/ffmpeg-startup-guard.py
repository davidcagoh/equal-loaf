#!/usr/bin/env python3
"""Run FFmpeg with a bounded input-initialization phase."""

from __future__ import annotations

import queue
import os
import subprocess
import sys
import threading
import time


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: ffmpeg-startup-guard.py <ffmpeg command...>", file=sys.stderr)
        return 2

    timeout = float(os.environ.get("BOSON_CAPTURE_STARTUP_TIMEOUT", "12"))
    process = subprocess.Popen(
        sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0
    )
    lines: queue.Queue[bytes | None] = queue.Queue()

    def read_output() -> None:
        assert process.stdout is not None
        for line in iter(process.stdout.readline, b""):
            lines.put(line)
        lines.put(None)

    threading.Thread(target=read_output, daemon=True).start()
    deadline = time.monotonic() + timeout
    initialized = False

    while True:
        try:
            line = lines.get(timeout=None if initialized else max(0, deadline - time.monotonic()))
        except queue.Empty:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            print(
                f"\nFFmpeg did not initialize capture within {timeout:g} seconds. "
                "Check macOS System Settings > Privacy & Security > Screen Recording, "
                "allow the terminal app running this script, then quit and reopen it. "
                "Also confirm the screen device ID with `ffmpeg -f avfoundation "
                "-list_devices true -i ''`. No microphone was opened by this watchdog.",
                file=sys.stderr,
            )
            return 124

        if line is None:
            result = process.wait()
            if result != 0 and not initialized:
                print(
                    "\nFFmpeg failed before capture initialized. Check Screen Recording "
                    "permission for this terminal app and verify the AVFoundation device IDs.",
                    file=sys.stderr,
                )
            return result

        sys.stderr.buffer.write(line)
        sys.stderr.buffer.flush()
        if b"Press [q] to stop" in line:
            initialized = True


if __name__ == "__main__":
    raise SystemExit(main())
