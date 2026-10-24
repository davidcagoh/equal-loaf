# Explorer, Audio, and Provider Assessment

Status: assessment only; no source implementation or live provider call was made.

## Findings

### Explorer and pose

- `packages/minecraft/src/demo-player.ts` moves the Mineflayer explorer along an autonomous pathfinder route. There is no WASD or mouse input path.
- `packages/minecraft/src/viewer.ts` serves the loopback Prismarine viewer and a Socket.IO pose stream. `packages/minecraft/src/viewer.test.ts` confirms that the initial position and yaw come from the server-side Mineflayer entity.
- `packages/minecraft/scripts/apply-prismarine-viewer-fix.cjs` patches the camera to follow the entity and retracts the camera boom when its ray probes hit world meshes. This is camera collision handling, not player movement or avatar collision handling. The view still follows the bot rather than providing a first-person mouse-look control.
- `packages/minecraft/src/village.ts` and `packages/minecraft/src/village-ai.ts` already use the explorer/resident positions for watch distance, route pauses, and rendezvous. The server-owned Mineflayer entity is the correct authoritative pose for perception; browser coordinates should never become authoritative.

### Current voices and playback

- `packages/minecraft/src/viewer-audio.js` consumes validated `village.dialogue` events, displays subtitles, and calls the browser's `SpeechSynthesisUtterance`. It selects an available system voice and varies pitch/rate by speaker ID. Voice availability and whether a voice is offline are browser/OS dependent.
- Playback is not spatial mixing: it changes one utterance's volume by distance, does not pan by direction, and calls `speechSynthesis.cancel()` before each line. SpeechSynthesis exposes no PCM or `AudioBuffer` source for this client to spatialize; it cannot support independent overlapping voice sources here.
- No bundled WAV/MP3/OGG/PCM voice asset was found. `whisper-cli` exists on the machine, but no `ggml-*.bin` or `ggml-*.gguf` model file was found. The CLI alone is not a usable offline ASR path.
- `scripts/viewer-audio-browser-harness.mjs` is a local browser harness for the current SpeechSynthesis path. It does not use a microphone or provider.

### Boson and other model routes

- `boson-api-demo/server.py` already has server-side Realtime client-secret creation and a text-to-speech route. `boson-api-demo/index.html` is a separate always-on/server-VAD microphone demo with game tools; reuse only server-side API patterns, not that capture lifecycle or its tool setup.
- The current village has no Boson speech adapter. The optional AI adapter in `packages/minecraft/src/village-ai.ts` uses Jev (`jev-latest`) to choose one bounded NPC action and Vercel AI Gateway (`openai/gpt-4.1-mini`) to choose an authored dialogue line ID. `BOSON_VILLAGE_AI` is off by default; neither route is a speech service. The gateway route currently has its own once-per-minute/three-request process cap and has no PTT transcript input contract.
- Environment inventory checked names and presence only. Boson key variable names are present in the Boson repository's ignored `.env`; `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY` names are present in the shared hub's ignored `.env`. No values were read or printed. These files establish local configuration presence only. Earlier Beads notes record a successful read-only Boson `/v1/models` request listing `higgs-realtime` and `higgs-stt-3.1`; that does not prove a Realtime/TTS session, available credit, monthly cap, or account balance. Balance and usable inference capacity remain unknown.
- Official Boson docs describe Higgs Realtime as a full-duplex WebSocket API, with configurable `instructions`, an optional `higgs-stt-3.1` input transcript, and one selected output voice per session. The documented manual-turn mode uses `turn_detection: null` and explicit input buffer commits. A 300-second client secret is supported. This fits one explicit PTT turn, but realtime session voice selection is not a per-character multi-voice mixer.
- Official Higgs TTS 3 is text-to-speech only, not dialogue or planning. `POST /v1/audio/speech` accepts a selected voice and can stream 24 kHz PCM. It is a candidate source for independently mixed character clips after text has been selected. Published price is US$0.015 per 1,000 input characters; generated audio is listed as free. Higgs Realtime's published estimate is US$0.0023/min audio input and US$0.014/min audio output, plus token-metered charges. Rates are estimates and can change; no call or account spend check was performed.
- No standalone Boson STT endpoint was confirmed in the current official docs index. The confirmed speech-to-text route for this design is Realtime's optional in-session transcript event. Do not treat `whisper-cli` as available ASR until a model is deliberately installed and its local-only behavior is verified.

## Recommended contracts

Keep one server-authoritative chain:

```text
browser controls -> validated server movement/look -> Mineflayer pose
     -> nearby-resident perception/hearing -> bounded social intent/dialogue
     -> approved speaker/text events -> independent spatial audio sources
```

1. **Controls and pose:** the browser sends only an allowlisted set of held movement buttons and bounded mouse-look deltas. The loopback server validates origin, message size, rate, and control names, then applies controls to Mineflayer. Only the server's current entity position/yaw/pitch are emitted for camera and perception. The Minecraft server remains authoritative for avatar collision and movement; camera boom collision is separately retained. Keep the visible body optional.
2. **Held PTT and transcript:** microphone permission is requested only by pressing the hold control. Send raw capture only to a Boson Realtime session while held. Stop the capture track and close/commit/cancel the turn on release, disconnect, navigation, or cap. Never send raw audio to Jev, Vercel, browser speech services, or any second provider. Realtime's transcript is transient and is not logged.
3. **Resident hearing and response:** on completed transcript, publish a short-lived local event carrying a turn ID, transient text, and the server-derived speech source position. The server finds eligible residents by current authoritative distance (and later optional occlusion), applies a hearing-radius cap, and shares only coarse context with one bounded intent/dialogue model. That model selects only among authored resident/line IDs, with no free-form lore, game tools, coordinates, or player identity. Do not send transcript to both Jev and the Gateway. Expire/cancel stale turn IDs and discard late responses.
4. **Audio:** return only approved resident output lines to the client. Route each speaker's clip into a separate Web Audio source/gain/panner keyed by speaker and utterance ID; update panning/attenuation from server pose snapshots, and dispose sources when done or stale. Local SpeechSynthesis can remain a no-mic fallback, clearly marked as serialized/non-spatial. Boson TTS is a configurable, capped option for independent voice clips, not an unconditional dependency. No captured user audio is relayed to residents or providers after transcription.
5. **Provider controls:** use server-only long-lived credentials and short-lived Realtime secrets. Default provider calls off until the run is explicitly enabled. Preserve per-run ceilings and add a hard TTS character/request budget; report estimated and actual usage separately. Missing keys, exhausted caps, denied microphone, or provider failures must fall back to authored local dialogue and the local voice path without interrupting exploration. Current account balance/cap remains unknown.

## Bounded implementation slices

| Slice | Ownership and result | Acceptance focus |
|---|---|---|
| Interactive explorer | `demo-player.ts`, viewer input module, viewer patch script, focused tests; no edits to `village.ts` | WASD movement and mouse look; first-person eye camera, optional body; server validates controls and remains sole pose authority; Minecraft collision blocks movement; viewer/player camera shuts down cleanly. |
| Hearing and response contract | Coordinate `.29` / `.28.10`; server-side perception adapter and typed transient events | PTT utterance becomes an expiring transcript event; only residents within earshot receive it; one bounded provider route chooses authored response IDs; no coordinates, raw audio, free-form world actions, or transcript logs. |
| Independent voice mixer | Coordinate `.30`; viewer audio client plus source/mixer module | Multiple speaker sources coexist, each has its own gain/pan/cleanup; distance and direction change playback; local fallback is explicitly serialized; Boson TTS calls are opt-in and hard-capped. |
| End-to-end integration | `.31` owner | Live local exploration, PTT, eligible-resident reactions and distinct audio; no paid call until the user-authorized cap and available balance/capacity are confirmed; graceful local fallback. |

The existing `.28.10`, `.29`, `.30`, and `.31` issues already cover much of the audio/dialogue sequence. A focused new explorer-input issue is filed separately under `.28`; avoid creating duplicate audio tasks until the master issue reconciliation assigns owners.

## Primary documentation

- [Boson Higgs Realtime overview](https://docs.boson.ai/models/higgs-realtime/overview)
- [Boson Realtime quickstart](https://docs.boson.ai/models/higgs-realtime/quickstart)
- [Boson Realtime audio and voices](https://docs.boson.ai/models/higgs-realtime/guides/audio-and-voices)
- [Boson manual turns and interruptions](https://docs.boson.ai/models/higgs-realtime/guides/turn-detection-and-interruptions)
- [Boson client-secret API](https://docs.boson.ai/api-reference/realtime/client-secrets)
- [Boson Higgs TTS 3 overview](https://docs.boson.ai/models/higgs-tts/overview)
- [Boson pricing](https://www.boson.ai/pricing)
- [Boson usage and limits](https://docs.boson.ai/account-billing/usage-and-limits)
