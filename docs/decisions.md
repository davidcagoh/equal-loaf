# Project decisions

## 2026-10-23: Initial feasibility checks

### Voice integration

- Use Boson Higgs Realtime (`higgs-realtime`) over `wss://api.boson.ai/v1/realtime` for the first end-to-end voice path. The official API supports full-duplex audio, tool calls, transcription events, and `server_vad` interruption handling.
- Keep model tool definitions narrow and dispatch only typed, whitelisted game goals through the companion scheduler. The model can request a client-side function call; the application remains responsible for validating and executing it.
- Stop local audio playback when `input_audio_buffer.speech_started` arrives. Keep cancellation in the local goal scheduler so a voice response cannot delay stopping a game action.
- Keep `BOSON_API_KEY` server-side. Browser clients must use short-lived client secrets rather than receiving the API key.
- API feasibility is confirmed from the docs, but live auth, quota, and latency are not verified: no `BOSON_API_KEY` is configured in this environment. Account credit is required; monthly caps can refuse requests; realtime concurrency overflow closes with 1013. Confirm account-specific limits and run a real smoke test when credentials are configured. Use documented push-to-talk or separate supported ASR/TTS only if live realtime proves unstable.

### Minecraft integration

- Candidate stack remains Mineflayer with `mineflayer-pathfinder`.
- Package metadata checked on 2026-10-23: Mineflayer 4.39.0 (Node.js >=22, MIT) and mineflayer-pathfinder 2.4.5 (MIT).
- Mineflayer's current tested-version list includes Java Edition 1.21.11 and 26.1. Choose 1.21.11 for the initial reproducible world because it is a named tested version; verify bot/server connection during world setup before building skills. No Minecraft client or server was present in the project repository during this check.

### Hackathon claims

- Boson AI's official 2025 recap dates the Toronto event October 24–26, reports 200+ participants, 50+ submissions and 16 finalists, and says each finalist presented for 10 minutes followed by 5 minutes of Q&A. It identifies EchoCharlie as the top spot and Cypress as Best Use of Audio Generation.
- The recap does not publish a complete official scoring rubric or all prize placements. Treat any proposed judging weights as internal strategy, not official criteria. Verify event-specific rules before making public claims.

## Primary sources

- [Higgs Realtime overview](https://docs.boson.ai/models/higgs-realtime/overview)
- [Higgs Realtime quickstart](https://docs.boson.ai/models/higgs-realtime/quickstart)
- [Turn detection and interruptions](https://docs.boson.ai/models/higgs-realtime/guides/turn-detection-and-interruptions)
- [Tool use](https://docs.boson.ai/models/higgs-realtime/guides/tool-calling)
- [Usage and limits](https://docs.boson.ai/account-billing/usage-and-limits)
- [Boson AI's 2025 hackathon recap](https://www.boson.ai/blog/inside-the-higgs-audio-hackathon)
- [Mineflayer package metadata](https://www.npmjs.com/package/mineflayer)
- [Mineflayer tested versions](https://github.com/PrismarineJS/mineflayer/blob/master/lib/version.js)
- [Mineflayer-pathfinder repository and license](https://github.com/PrismarineJS/mineflayer-pathfinder)
