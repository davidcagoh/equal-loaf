# Boson API demo

This collaborator-provided local demo exercises Boson Realtime, TTS, and Avatar APIs. Realtime can submit whitelisted Minecraft goals to the typed scheduler. The gateway connects a loopback Mineflayer adapter and fails closed when Minecraft is unavailable. The Realtime panel shows adapter readiness, observed player/bot positions and inventory, speech, the current goal, and recent action outcomes, with a local stop control. Keep credentials outside Git; root `.env`, `.api`, `BOSON_API_KEY`, and `BOSON_API_KEY_100` are supported.

## Endpoints and workflow fit

| Demo | Endpoint | What it does | Fit |
|---|---|---|---|
| Higgs TTS | `POST /audio/speech` (`higgs-tts-3`) | Generates narration audio from text and a selected voice. | Could supply the voice stage. Requests use the current `normalize` and ISO 639-3 `language` fields (`eng` for this English demo). The local text limit is 5,000 characters; streaming requests can support up to 50,000, but streaming TTS is not wired into this UI. Voice goal calls wait up to 32 seconds for a scheduler terminal event and return a grounded completed, cancelled, failed, or still-running result; acceptance alone is never reported as completion. The demo returns audio only; word-level timestamps require a non-streaming request with `timestamps: true` and are not wired into this UI. |
| Higgs Realtime | `POST /realtime/client_secrets`, then browser WebSocket | Mints an ephemeral credential (requested lifetime: 600 seconds) for direct browser voice conversation and tool calling. The browser disconnects after five minutes and turns off the microphone. Speech interruption stops local playback and requests scheduler cancellation. | Interactive companion voice path; action execution requires a connected Minecraft adapter. |
| Higgs Avatar | `POST /videos` (`higgs-avatar`) | Creates a speaking portrait from narration and an optional still image, then polls and retrieves the MP4. | Tests portrait narration/lip-sync. It does not animate a sequence of illustrated scenes and is not a substitute for SSKU-style scene motion. |

The broader workflow is **approved transcript → voice → timing/alignment → original scene images → video assembly**. TTS could be assessed for the voice step and timestamp support, while Avatar is a separate talking-head format. The current demo does not connect TTS timestamps to the project's alignment or Reel renderer.

## Requirements and local run

- Python 3.10+, Node.js 22.6+ (tested with 24.12), Java 21+, and a Boson API key with access to the requested endpoints.
- Install the pinned Mineflayer adapter dependencies with `npm ci --prefix packages/minecraft`. Start the local world in one terminal with `bash scripts/start-minecraft-world.sh`; the configured server runs only on loopback in offline mode.
- A Minecraft account is not required for the companion. To provide an account-free moving target, run `npm --prefix packages/minecraft run demo-player` in a second terminal and set `BOSON_MC_PLAYER=DemoPlayer` when starting the companion.
- Put the key in the ignored project-root `.env` as `BOSON_API_KEY_100`, or set `BOSON_API_KEY` in the environment. Never commit or paste the key.
- Browser microphone audio is sent directly to Boson while the Realtime session is active. Grant browser access only when ready; stop the session when finished.
- Start from the project root:

  ```sh
  bash scripts/start-companion-demo.sh
  ```

- Open `http://127.0.0.1:8000`. The browser connects to Boson for Realtime and requests microphone access. Server VAD threshold defaults to 0.70 and can be tuned in the UI (the provider default is now 0.85). TTS and Avatar buttons submit paid API requests. Local request limits are 10 TTS, 5 Realtime-key, and 3 Avatar requests per hour. Realtime auto-disconnects after five minutes.

## Cost and authorization

The demo makes live vendor requests; it is not a free sandbox. The locally documented official prices checked on 2026-10-20 were TTS at **$0.015 per 1,000 characters** and Avatar at **$0.09/minute at the demo's 640×640 size** (other listed sizes started at $0.07/minute). Actual billing can depend on duration, minimums, rounding, account access, and current vendor pricing. A confirmed Realtime price is not recorded here. Check the vendor account/pricing immediately before any request. Avatar generation is not part of the companion path and should remain unused.

The API key is read by the local Python server and is never sent to the browser. Realtime receives only the short-lived client secret. Microphone audio is sent directly from the browser to Boson while a session is active. Use a short session, stop it when finished, and do not speak sensitive information. The planned SSKU motion test is separately paused.

## References

- [Boson pricing](https://www.boson.ai/pricing)
- [Higgs TTS word-level timestamps](https://www.boson.ai/blog/higgs-tts-normalization-timestamps)
- [Project media workflow and archive](../../../strategy/knowledge/research/media-archive.md)
