# First-person living village architecture

Status: architecture proposal for the next playable slice. This records repository evidence separately from desired behavior; it is not implementation evidence.

## Product target

The player controls a first-person explorer in a village whose residents have bounded routines, different knowledge and relationships, and short-term memory. Residents can hear nearby conversations and react to a player's held push-to-talk turn. The model classifies a turn as bounded intent and chooses only a permitted authored response ID; local policy pairs that with an authorized action and renders the authored line. Authored Quiet Bell mystery beats remain canonical. The experience runs locally; only microphone audio captured while PTT is held is streamed to Boson Realtime, under the already approved provider boundary. No ambient microphone capture, transcript/audio retention, always-on session, or multi-provider raw-audio fanout.

## Current repository state and reusable assets

- `packages/minecraft/src/village.ts`: three Mineflayer actor loops, movement toward authored stops, proximity awareness, one serial NPC-to-NPC dialogue/rendezvous loop, and JSONL dialogue events. Dialogue pacing still blocks on rendezvous and an 8 second wait.
- `packages/minecraft/src/village-profiles.ts`: three residents, role-specific routines, nine ambient turns, and six fixed mystery turns.
- `packages/minecraft/src/village-event.ts`, `viewer.ts`, and `scripts/run-village-with-dialogue-relay.mjs`: typed dialogue event, loopback-only viewer, POST/SSE transport, and launcher relay.
- `packages/minecraft/src/viewer-audio.js`: browser local SpeechSynthesis, resident-specific voice selection, subtitles, distance-to-volume mapping, pause/stop. Playback cancels the current utterance, so voices do not layer; attenuation is scalar volume, not positional panning.
- `packages/minecraft/src/demo-player.ts` and `scripts/apply-prismarine-viewer-fix.cjs`: an auto-routed explorer and a third-person follow camera. First-person camera and direct player controls are not present.
- `packages/minecraft/src/village-ai.ts`: optional Jev action selection and Vercel line-id selection with strict caps and authored fallbacks. Jev currently receives only resident/activity and selects an action verb; it has no memory, relationships, story state, user intent, or beat ownership. The Vercel adapter may select among authored dialogue IDs but must remain disabled unless explicitly configured.
- `boson-api-demo/server.py` and `boson-api-demo/index.html`: existing server-side ephemeral-secret pattern and a separate, older always-on Realtime interaction demo. Reuse only the secret-minting/security pattern. Do not copy its always-on capture, game tools, goal gateway, or direct game authority into the village path.
- `docs/village-mystery-design.md`: Quiet Bell fixed answer, clue order, character knowledge, pacing and local-first constraints. Its desired behaviors are proposals, not current implementation facts.
- `docs/explorer-audio-provider-assessment.md`: provider/API capability audit, confirmed absence of mixable audio in SpeechSynthesis, published TTS/Realtime estimates, and account/capacity unknowns. No inference call or secret read was made during that assessment.

## Proposed runtime boundaries

```text
First-person input + server-authoritative player pose
        │                         │
        │ held PTT audio          └─ proximity/perception events
        ▼                                      ▼
Loopback PTT broker ── ephemeral Boson Realtime audio + text-only response
        │ {playerIntent, topic, lineId}
        ▼
Scoped text cognition ── typed intent + allowed authored response ID
        │                                      │
        └──────────────────────────────────────┤
                                                ▼
                              Resident memory + relationship state
                                                │
                                      Beat/intent director
                                  ┌─────────────┴──────────────┐
                                  ▼                            ▼
                      Bounded resident actions          Speech intent
                                  └─────────────┬──────────────┘
                                                ▼
                         Boson Higgs TTS voice clip (per speaker)
                                                ▼
                         Timestamped speaker/position audio events
                                                ▼
                          Independent per-speaker spatial voice mixer
```

Keep the village simulator authoritative for actor state, interaction eligibility, memory updates, beat prerequisites, and action allowlists. Keep provider connectivity in a small PTT boundary. Boson Realtime receives raw audio once, only while held, and returns a text-only response; it is not used as a multi-NPC mixer. Its selected-resident instructions include only ordinary/public facts and a per-turn list of allowed authored response IDs. Strictly parse `{playerIntent,topic,lineId}`, then validate the chosen ID and intent against current local state. The model gets no tools or direct game/story authority, and no free-form speech text is accepted. A private-clue beat may override the ordinary response with its authored line only after local prerequisites pass. Boson Higgs TTS can synthesize that local authored line with the selected resident's configured voice; each returned clip is transient and enters the per-speaker browser mixer. Provider failure, invalid output, or exhausted caps returns to authored local behavior and browser-local speech, explicitly marked degraded and non-layered.

## Shared contracts

Use a versioned, validated event envelope across the simulator, PTT broker, and viewer. Keep these types in the existing contracts package or a focused village contract module; do not introduce a second transport listener.

```ts
type VillageEvent =
  | { version: 1; type: 'player.intent'; turnId: string; intent: PlayerIntent; targetResidentId?: string; at: number }
  | { version: 1; type: 'resident.intent'; residentId: string; intentId: string; action: ResidentAction; speech: SpeechIntent; beatId?: string; at: number }
  | { version: 1; type: 'village.utterance'; utteranceId: string; speakerId: string; line: string; position: Point3; audience: 'nearby' | 'direct'; at: number };

type PlayerIntent = 'greet' | 'ask_about_known_topic' | 'ask_for_help' | 'leave' | 'unknown';
type ResidentAction = { kind: 'idle' | 'look_at_player' | 'continue_routine' | 'walk_to'; waypointId?: string };
type SpeechIntent = { kind: 'authored_line'; lineId: string };
```

The event transport validates sizes, types, IDs, and loopback origin. Raw audio and transcript never enter the village event stream or logs. The Realtime text response contains only bounded semantic fields and a response ID, not a generated line. A turn may update session-local memory with a small typed summary (topic asked, clue already discussed, relationship delta, time); reset it at demo shutdown. Private resident knowledge is an authored allowlist keyed by resident and clue. A heard utterance can update another resident only when the server-side hearing predicate succeeds. Every resident in range may receive a typed semantic perception summary, not a copy of the transcript; only the selected responder receives its ordinary/public context and allowed response-ID list. Local policy renders the response ID to an authored line and checks clue disclosure prerequisites; the model cannot grant knowledge or alter canonical clues. If validation fails, use an authored fallback or silence.

The viewer consumes each utterance with a stable speaker ID, world position, timestamp and optional duration/source metadata. For a player utterance, emit a transient perception event to every resident whose server-side hearing predicate passes; the nearest eligible resident gets response priority, while other in-earshot residents can independently update memory and may react later through authored beats. Do not broadcast raw audio or transcript text to other residents. Maintain one queue/channel per speaker, apply distance attenuation and optional stereo panning, and enforce a global concurrency cap with deterministic ducking/priority. Subtitles remain readable independently of hearing volume; far-away speech is not delivered as a player-facing subtitle. Stop/release/navigation cancels only the corresponding PTT response; global Stop shuts down all channels cleanly.

## Cognition cycle

1. Collect authoritative stimuli: scheduled activity, resident utterance, player position/distance band, visible event, validated PTT intent, and prior session-local memory summary.
2. Apply a deterministic reducer to the receiving residents' private known facts, recent memory, and bounded relationship dimensions. Do not let one resident's knowledge become global village knowledge.
3. Evaluate authored scene beat prerequisites, cooldowns, participants, locations, and evidence thresholds. The Quiet Bell answer and clue order are immutable authored data.
4. Select one short-lived intent. The intent binds a beat, actor, allowed waypoint/action, eligible line intent, and expiry. Expired or ineligible intents are discarded.
5. Validate/execute the local action and emit the matching speech intent. Generated wording is temporary and constrained to the speaking resident's known facts; invalid output uses an authored line or silence.
6. Emit the utterance event to eligible nearby listeners and the viewer. Update listener memory only for residents inside the hearing radius and not blocked by the scenario's hearing rules.

Use a deterministic simulation clock/seed for reproducible routines and tests. Provider latency is asynchronous and never blocks routine ticks, safe fallback movement, PTT release, or shutdown. Avoid per-frame model calls and open-ended autonomous plans.

## Decisions and trade-offs

| Decision | Pros | Cons / alternatives | Choice |
|---|---|---|---|
| Single authoritative simulation/reducer with local resident state | Coherent truth, testable clue boundaries, reproducible behavior | More explicit state modeling than independent prompt-per-NPC agents | Choose; it keeps agency bounded and allows private knowledge |
| Authored beat director; models classify intent and choose allowed response IDs | Mystery stays canonical; action and speech stay aligned | Less free-form improvisation | Choose for first playable slice; no open-ended world planner or generated lines |
| Boson Realtime STT while held, scoped text cognition, Boson Higgs TTS clips | Matches explicit owner approval; one raw-audio path and supports independent per-speaker mixing | Costs are metered; Realtime voice is single per session and cannot serve as the ambient mixer | Choose; set character voice before TTS, cap both audio input and TTS, keep transcript/text transient, local degraded fallback |
| Session-local structured memory, not transcript archive | Supports continuity while limiting stored user data | Resets between runs; no persistent relationship history | Choose for demo; revisit persistence only with a clear product need |
| First-person control as camera/input owner, server-authoritative movement | Immersive, supports walk-and-listen; trustworthy pose for distance/hearing | Requires replacing auto-walk path and validating Prismarine control support | Choose; retain a camera/input abstraction so third-person can remain a later mode |
| Per-speaker client audio channels with a concurrency policy | Supports nearby layered village ambience and distinct speakers | Browser SpeechSynthesis has limited mixing/panning control | Choose; feature-detect and document a local fallback; use Web Audio only if speech source permits it |

## Ordered delivery slices and ownership seams

1. **Cognition kernel and Quiet Bell slice** — story owner owns `village-profiles.ts`, new reducer/beat/memory modules and tests. Architecture/integration owner owns `village.ts` event/simulation glue and shared contracts, after event shapes are reviewed with cognition and player/audio owners. Deliver independent routine ticks, typed stimuli, per-resident knowledge/memory/relationship state, authored beat prerequisites, and `resident.intent` producing both bounded action and authored speech ID. First slice: greet/ask Anna near the garden; respect her trust/place prerequisite; reveal her sighting, with Thomas's contradiction only corroborative. No provider dependency for correctness.
2. **First-person controls and PTT boundary** — player/audio owner owns `demo-player.ts`, viewer input/camera patch, and a dedicated village PTT route/client code. Deliver direct movement, first-person camera, actual server pose, accessible held PTT with permission requested on explicit press, immediate media-track shutdown on release, one Boson Realtime raw-audio path, text-only semantic response `{playerIntent,topic,lineId}`, all-resident in-earshot perception with nearest eligible response priority, server-minted short-lived secret, no tools, no logging/retention, session/turn/audio-spend caps and authored fallback. Do not edit ambient simulator/audio implementation concurrently.
3. **Hearing and layered voices** — player/audio owner owns `viewer-audio.js` and audio-specific tests. Deliver hearing eligibility/proximity from authoritative pose, Boson Higgs TTS clip transport, per-speaker WebAudio queues/sources, subtitles, distance response and clean pause/release/stop behavior. Use 1,000 TTS input characters as the initial smoke-test cap (current published estimate: US$0.015 total), plus a bounded response-word limit; keep the cap configurable and report actual provider usage when available. Do not expand it beyond the owner-approved spend policy. Keep credentials server-side. Ensure one NPC does not hear through the wall/at arbitrary range; keep line display accessible independent of sound volume. Browser SpeechSynthesis is fallback only and must be labeled degraded/non-layered.
4. **Integrated local acceptance** — launcher/docs owner owns scripts and user documentation; architecture/integration owner owns `village.ts` glue and shared event contracts. Deliver one reproducible loopback launch, first-person entry, ambient routines, PTT turn to a nearby resident, resident action plus speech aligned to one intent, nearby ambient overhearing with at least two distinct spatial voices, stop/release/privacy checks, fallback without credentials, and clean shutdown. Keep the current no-relaunch instruction in force until the owner authorizes a bounded run.

Dependencies: cognition event/intent contract precedes PTT routing and hearing-memory updates; viewer speaker/position contract precedes layered audio; PTT and cognition implementations can proceed behind the agreed contracts; integrated acceptance waits for all three. Use synthetic fixtures for implementation verification; run a local smoke once the integrated build is ready. A live user PTT turn requires an explicit held gesture. Do not make optional Jev/Vercel or the judge video gate a prerequisite.

## Integrated acceptance for the next milestone

- Start one loopback-only, Minecraft-account-free demo from the documented command; no automatic terms acceptance. Boson Realtime is used only for explicit held PTT under the owner-approved cap; missing credentials or provider errors leave ambient authored behavior usable.
- The player starts in first person and can walk with direct controls; the position used for resident awareness and hearing is authoritative from the same connected explorer entity.
- At least three residents perform distinguishable bounded routines; one Quiet Bell beat is eligible only after its authored prerequisites. A resident's unknown clue remains unavailable until learned through an eligible event.
- Hold PTT explicitly: request microphone access at that point only, send raw audio once and only during hold to Boson Realtime, request text-only response `{playerIntent,topic,lineId}` from the session with tools disabled, and send a transient semantic player-speech perception event to every in-earshot resident. Give response priority to the nearest eligible resident. Stop tracks/provider input promptly on release. No raw audio, transcript, or generated lines in logs or durable files; enforce session, hold, text, TTS characters/audio duration and usage caps. No tools or direct model control of Minecraft.
- A validated conversational intent produces a coherent bounded resident action and matching locally rendered authored response. Provider failure/invalid output falls back to authored behavior without pausing routines or corrupting memory/story state.
- A resident speaking within range can be overheard by the player and eligible nearby residents; an out-of-range resident gains no knowledge. The viewer shows speaker/subtitle, mixes independent per-speaker Boson TTS clips, and varies perceived level/position with distance. Simultaneous speech follows an intelligible queue/ducking policy. Local SpeechSynthesis fallback is visibly marked degraded and non-layered.
- Ctrl-C/release/navigation closes capture, provider transport, viewer streams, speaker queues and all launcher children. Report observed local output/provider usage without claiming physical audibility unless the owner confirms it.

## Not in this slice

Open-world LLM autonomy, mutable mystery truth, persistent transcripts, combat, arbitrary Minecraft tools, social simulation at population scale, cloud deployment, judge recording, kitchen co-op, or second-game expansion.
