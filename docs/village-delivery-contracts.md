# Village delivery contracts

This page records current ownership boundaries and gates for the playable village. Beads remains the workflow source of truth; this is an interface and evidence contract, not a second task board.

## Component boundaries

| Slice | Owner | Contract / evidence |
|---|---|---|
| First-person controls and PTT client/server | Player/audio | `viewer-ptt.js`, controls and PTT modules, browser harness and UI. Browser sends bounded input only; server reads authoritative positions. PTT is explicit and held-only. |
| Shared event contract and village composition | Architecture/integration | `village-event.ts`, `village.ts`, `village-encounters.ts`. Versioned bounded commands/events; positions and range decisions come from server entities. No transcript or raw audio enters village events. |
| Cognition and authored scene | Story | Existing cognition contracts plus isolated scene module/tests. Story code owns resident-specific knowledge and authored line/fact IDs; it does not edit shared runtime contracts before integration. |
| Audio harness | Player/audio | Reuses production PTT/TTS modules on loopback without Minecraft. Harness acceptance proves UI/component wiring and bounded status only; provider and mic use are human-only. |
| Scene composition | Architecture/integration after `.28.24` and `.28.25` | Maps the isolated scene's typed outputs to recipient-scoped cognition observations/events. Preserve independent resident state, routine movement, and existing hearing rules. |
| Final journey | `.28.27` owner | One live, deliberate human-held PTT journey with actual mic release, nearby resident, semantic response, spatial voices, scene discovery and closure. Component fixtures do not satisfy this gate. |

## Event and encounter interface

The viewer/PTT boundary exchanges validated `ptt.begin`, `ptt.complete`, and `ptt.cancel` messages over the existing private per-run IPC path. A begin acknowledgement contains either a safe response allowlist or a bounded `no_resident` guidance string. It carries no client-supplied resident identity or position. The village resolves the nearest eligible resident from Mineflayer entity positions using the existing 8-block response radius; the separate 12-block perception radius controls which residents receive the semantic observation. A nearby resident may hear without being eligible to answer.

Completion accepts only `{playerIntent, topic, lineId}` against the selected resident's current allowlist. Local cognition selects an eligible beat and renders authored text. Invalid/missing provider output uses local authored fallback. The server-side journey and authored response path can be tested with deterministic fixtures and no provider credentials.

For the isolated story scene, use existing intent/topic and cognition observation types at the integration seam. Scene transitions must be event-idempotent and return typed authored line/fact identifiers; integration assigns knowledge only to explicitly eligible residents. No physical prop, inventory change, unrestricted model prose, or global shared knowledge is implied by a scene response.

## Delivery gates

1. Component preparation is parallel: isolated audio harness/UI, encounter guidance, and isolated story authoring can proceed without restarting the main demo or invoking mic/provider access.
2. `.28.17.6` closes only after focused fixed-encounter tests and review/commit. It proves reachability logic and preserved spatial predicates, not live speech.
3. `.28.17.7` closes on a rendered no-mic preflight and clean owned-file review/commit. Human PTT evidence is tracked separately; `.17.8.1` already records audible authored TTS but does not prove Realtime semantic response or release timing.
4. `.28.17.10` integrates the simplified audio UI after `.17.9` and `.17.9.1`; it is the main-viewer audio integration gate.
5. `.28.26` waits for the isolated scene and integration contract, then verifies the production no-provider PTT/IPC/cognition/event path with fixtures. Do not restart a user-owned runtime. Scene rendering and the complete live journey remain in `.28.27`, after `.17.10` and the audio-owned `.17.13` client line-ID fix land.
6. `.28.27` is the separate complete live journey gate. `.28.1` walkthrough capture follows it. Kitchen design/implementation and commercial validation remain downstream of demonstrated MVP evidence, not prerequisites for village work.

## Review and runtime boundaries

Each department stages and commits only its owned files with the issue ID in the commit message. Shared runtime ownership is architecture/integration; do not stage another department's dirty files. The existing main viewer on port 3000 is the no-provider visual/movement runtime. Audio harness processes and any human-controlled live review are separate. Agents do not request mic access or initiate provider calls. A component commit does not require a fresh mic run; the final integrated live gate does.
