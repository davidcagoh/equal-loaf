# Native resident reaction contract

**Status:** interface proposal only. No engine, server, browser, or provider integration is claimed here.

## Goal and operating boundary

Allow a nearby resident to speak briefly because of an existing routine transition or something that resident actually heard. A reaction is conversational output only: it cannot move a resident, change inventory, or assert that an engine action occurred.

After the user intentionally activates native audio with a talk/audio gesture, a separate session manager bootstraps persistent Realtime sessions for a bounded set of nearby residents, including residents the user has never addressed with PTT. The manager owns session creation, reconnect, and teardown; the reaction dispatcher never mints credentials or sessions in response to routine events. Bootstrap requires the browser reaction stream and a live audio playback path, uses server-authoritative resident identities, does not open or infer from the microphone, and does not start from idle background inference. Enforce a configured nearby-session limit and retire sessions when residents leave range, the client disconnects, or the audio experience is deactivated. A resident without a live session, reaction SSE connection, or current capacity drops the trigger; it must not leave the scheduler permanently active.

The player-transcription path remains separately opt-in under `.31.1`. A completed player transcript may become an attributed heard event only after the server has accepted it and the engine has projected it to in-range residents. This contract does not enable transcription by default.

## End-to-end lifecycle

1. **Activate native audio and bootstrap sessions.** The browser calls the session manager only from a trusted user talk/audio gesture handler, and resumes audio playback there; the request itself is not proof of activation. The server validates same-origin requests, selects eligible nearby residents from authoritative world state, enforces the configured activation/session limits, and returns server-bound session identities and short-lived credentials through a bounded handshake. Credentials cannot be replayed to create additional sessions. The client opens those sessions and per-session reaction streams; no microphone capture occurs. The manager reconnects or tears down sessions under the lifecycle rules above. A session bootstrap failure leaves that resident ineligible and does not create a reaction slot. Browser autoplay policy still requires the intentional gesture before audio playback.

2. **Create an eligible event in the engine.** Enqueue one event when a resident enters a meaningful routine activity, not on every routine polling tick. Also enqueue a newly perceived completed speech event for each eligible listener. The event carries a stable engine `eventId`, `residentId`, source/origin, causal depth, bounded private context, creation time, and expiry. Do not include client-supplied position, speaker identity, or a session ID.

3. **Schedule per resident.** Keep one active event and at most two pending events per resident. Use the committed policy defaults: 30-second pending TTL, 15-second post-completion cooldown, duplicate suppression, and self-heard rejection. Heard player/conversation events outrank routine prompts; when space is tight, drop stale/low-priority routine prompts first. Propose a global cap of three active reactions to bound layered output. This is a new scheduler policy: the native PCM mixer has no max-concurrent-source cap, and the existing scheduler has no global active cap or heard-versus-routine priority. Implement and validate the cap and priority in the reaction scheduler. Do not let a missing recipient session occupy a slot.

   A native reaction may trigger at most one further resident response. Tag its eventual heard event with causal depth 1; a response at depth 2 is remembered but cannot enqueue another reaction. All claims remain attributed and unverified. Routine prompts may describe current activity and motive, but cannot invent world facts or claim to perform actions.

4. **Ask the server to dispatch.** The engine emits a bounded `village.native.reaction` candidate with its engine-owned `eventId`, `residentId`, source/origin, causal depth, context, creation time, and expiry. The relay forwards it to the same-origin viewer server. The server resolves the resident's existing `residentSessionId`; the engine event and browser never choose that binding.

   If there is no bound, connected resident Realtime session or no open reaction stream, the server returns an unavailable result to the engine so it releases/drops that event. The engine must also release on dispatch timeout or stream loss; deleting only the server's correlation entry would strand the per-resident active slot.

5. **Issue a server correlation and send only to that session.** For a dispatchable candidate, the server creates a random `reactionId` and short-lived mapping:

   ```text
   reactionId -> { eventId, residentId, residentSessionId, causalDepth, expiresAt }
   ```

   Send `{reactionId, eventId, residentId, context, causalDepth, expiresAt}` over the SSE stream belonging to that resident session only. Do not persist or replay the context. Reject stale, duplicate, mismatched-session, and expired events.

6. **Acknowledge, then request speech without microphone input.** The browser checks that the mapped resident session is live and not already handling player PTT or another reaction. It posts `{reactionId, residentSessionId, status: 'accepted' | 'busy' | 'unavailable'}`. The server resolves the resident and event from its mapping and forwards the acknowledgement to the engine. Non-accepted status releases the scheduler slot and ends the dispatch.

   On acceptance, add one bounded text input item that clearly labels its source and attribution, then send `response.create` on the existing resident Realtime WebSocket. Do not open the microphone, synthesize a player turn ID, or route a reaction through the PTT speech endpoints.

7. **Correlate output and report playback.** On the first reaction audio item entering the spatial mixer, report reaction start using the server-issued `reactionId`, provider `responseId`, and output `itemId`. Keep chunks, transcript, and playback state associated with that reaction. Report `playback: completed` with the bounded final transcript only after the response is complete and every scheduled audio chunk has drained from the mixer. Report `interrupted` without transcript if playback stops early. A generated transcript or `response.done` alone is not evidence that the line played.

8. **Project only completed, spatially eligible hearing.** The engine validates the active reaction mapping, samples the speaker and nearby resident positions during browser playback, and projects a completed utterance only to residents who stayed within the 12-block hearing radius for the sampled interval. This is the existing conservative whole-playback approximation; it does not prove physical audibility or model partial hearing. Store the result as private, attributed, unverified memory, using the existing bound of three events per resident with a three-minute TTL. Never store audio or treat the transcript as established world truth.

9. **Release or complete exactly once.** Completed playback calls scheduler `complete(residentId, eventId)` and starts its cooldown. Busy/unavailable dispatch, interruption, expired correlation, connection loss, or failed audio calls `release`; it must not create heard memory. Remove the server mapping and stop position sampling on every terminal path.

## Player priority and concurrency

- A player-held PTT interaction has priority for its selected resident. If that resident is speaking a reaction, cancel/truncate that response, report it as interrupted without transcript, release its scheduler slot, then begin player capture. Do not interrupt unrelated residents unless the global three-reaction cap requires capacity.
- Require one active reaction per resident and propose at most three across the village; the global cap is not currently enforced by the native mixer or reaction scheduler. Allow up to two queued events per resident; stale events expire rather than accumulate. Avoid a global speaker lock so separate residents can play independently within the cap.
- Preserve the existing persistent resident sessions across PTT turns. Reaction dispatch is eligible only while the browser's session and its reaction stream are live. Do not fetch a new credential from a background routine.
- Trigger routine reactions on activity entry/meaningful change, not a polling loop. Cooldown, source priority, dedupe, and causal depth prevent chatter and reciprocal echo.

## Ownership and dependency order

Keep file ownership disjoint. Do not merge dirty candidate edits from the canonical checkout automatically; use this contract as the interface boundary.

1. **Native audio session manager:** own the activation handshake, server-authoritative nearby resident selection, bounded session creation/reconnect/teardown, credential delivery, reaction-stream setup, and lifecycle tests. Coordinate this endpoint/client work with `.31.1` because the native client and relay overlap. Reaction dispatch must consume only sessions already established by this manager.
2. **Engine producer/consumer:** `packages/minecraft/src/village.ts` and focused engine tests. Integrate `ResidentNativeReactionScheduler`, create routine/heard triggers, consume dispatch/start/finish results, sample reaction playback, project completed speech, and release/complete on every terminal status. Depend only on the stable command/event schema below.
3. **Server and relay transport:** `packages/minecraft/src/viewer-ptt-server.ts`, `packages/minecraft/src/village-event.ts`, `scripts/run-village-with-dialogue-relay.mjs`, and server/relay tests. Validate bounded engine events and browser payloads; bind session and reaction IDs server-side; own SSE delivery, timeout cleanup, and IPC acknowledgements. This owner must coordinate first with `.31.1`, which owns the player transcript ACK hunk in the relay file; land that work before editing the same relay file.
4. **Browser reaction consumer:** `packages/minecraft/src/viewer-ptt-native.js` and focused client tests. Subscribe per resident session, handle SSE ACK/start/finish paths, insert text and request a response without mic input, mix concurrent resident output, wait for full playback drain, and prioritize PTT interruption. This follows `.31.1`'s transcription/options work in the same client file; do not modify it concurrently.
5. **Integration owner:** after 1–3 land, add provider-disabled cross-boundary fixtures covering event → session dispatch → client request → played completion/interrupt → engine memory/release, and human acceptance of a busy scene. No unit fixture alone closes the integration issue.

Steps 1 and 2 can proceed in parallel after the schema is agreed; step 3 can also be implemented in parallel against the frozen schema, but must be serialized with `.31.1` edits to the same browser file. Integration tests follow all three.

### Stable message shapes

These names describe the boundary; server-issued correlation always wins over client fields. The session activation request carries no resident IDs or positions; the server selects residents from authoritative world state. These shapes are proposals to freeze before implementation:

```text
client activation: POST native-audio/activate {} (called only inside trusted browser gesture handler)
activation reply:  {activationId, sessions: [{residentSessionId, residentId, shortLivedCredential, reactionStream}]} (activationId server-issued)
client deactivate: POST native-audio/deactivate {activationId}
engine stdout:   village.native.reaction {version, eventId, residentId, origin, causalDepth, context, createdAt, expiresAt}
browser SSE:     native.reaction.dispatch {reactionId, eventId, residentId, context, causalDepth, expiresAt}
browser ACK:     POST reaction/ack {reactionId, residentSessionId, status}
browser start:   POST reaction/speech/start {reactionId, residentSessionId, responseId, itemId}
browser finish:  POST reaction/speech/finish {reactionId, residentSessionId, responseId, itemId, playback, transcript?}
engine IPC:      reactionId + server-resolved eventId/residentId + status or provider output correlation
```

All handlers use exact-key validation, same-origin checks, byte limits, bounded IDs, deduplication, and expiry. Client positions and speaker IDs are never accepted as authoritative. Reactions are separate from PTT `turnId` lifecycle.

## Required tests and acceptance

- Scheduler: routine entry and heard speech enqueue once; player/heard events outrank routine; queue, TTL, cooldown, dedupe, self-heard, causal-depth, and live-session failure release are bounded per resident and globally.
- Session manager: an intentional audio gesture bootstraps a bounded set of nearby residents never individually PTT-addressed; resident identity and eligibility come from server state; teardown/reconnect limits hold; no microphone or idle inference is started.
- Server/relay: only a connected matching resident session receives its dispatch; server owns `reactionId`; duplicate/stale/forged session ACK/start/finish and every timeout/connection-loss path release state; reaction commands never need or accept a PTT turn ID.
- Browser: dispatch on one of two resident sessions cannot cross to the other; `response.create` follows text insertion and never requests mic audio; ACK rejection starts no response; generated transcript does not finish before mixer drain; PTT to the active speaker truncates and reports interruption while another resident can continue.
- Cross-boundary, provider-disabled fixture: activate audio with the intentional gesture, bootstrap two nearby residents never individually PTT-addressed, and dispatch an eligible routine and nearby player/heard event without a PTT hold; two outputs remain independently correlated/spatialized; completed output becomes attributed private memory for continuously in-range listeners only; interrupted output creates no memory; there is at most one reaction hop and no self-response loop.
- Live human review: after the user activates native audio once, a busy village produces brief speech relevant to an existing routine or nearby heard event from residents never individually addressed by PTT, with distinct resident voices positioned while moving. Record failures and conditions where activation or nearby sessions were unavailable. This is separate from proving actual physical audibility.

## Explicit limits

This contract does not promise output before intentional native-audio activation, full natural conversation quality, partially heard syllables, or physical audibility. It does not make speech authoritative world state, add routine speech on every polling cycle, or allow dialogue to execute game actions. The committed policy and dirty server/relay drafts are components, not a connected reaction feature. The activation endpoint and handshake above are required new work, not an existing capability.
