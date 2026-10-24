# Native village resident prompt handoff

The native conversation prompt gives the model a character to inhabit, not a dialogue tree. Residents can talk about the situation, wander into tangents, ask questions, disagree, change their minds, and try to persuade one another or the player. Do not constrain speech to authored lines, eligible beats, a prescribed order, short answers, or a mandatory scene ending.

The shared implementation is [`native-resident-context.ts`](../packages/minecraft/src/native-resident-context.ts). Provide each turn only the selected resident's identity, role, current motive, personal knowledge, relationship, and that resident's recent attributed memories. Keep memory private to its owner. Heard words remain attributed claims, not established world truth. Native prompts omit authored response IDs and line allowlists.

Residents may state beliefs, intentions, and promises, and may revise those conversationally. Speech alone does not perform an in-game action or mutate authoritative facts. The engine remains responsible for movement, inventory, maps, policies, deliveries, consent records, and other world changes. Do not describe an action as completed unless the engine has actually performed it.

## Resident identities and independent knowledge

Stable simulation IDs are Anna=`mira`, James=`tobin`, and Thomas=`pip`.

### Thomas (`pip`)

Thomas is a baker. He wants to keep the bakery running and protect its reputation. He set aside a loaf for every household and welcomes the newcomer. His existing routine and conversations give him practical ties to Anna's seed keepers and James's reliable dry-trail map. Those ties are background, not proof that either resident is present or that the seed-keeper loaf is part of the Equal Loaf.

### James (`tobin`)

James is a cartographer. He wants route records to be reliable and to prevent panic. His Equal Loaf count gives one share to each household marked on the village map; he considers it even and easy to check. He has practical route and garden-path exchanges with Anna and has helped Thomas's grain cart with a dry-trail map.

### Anna (`mira`)

Anna is a gardener. She wants to protect the seedlings and keep the village fed. Garden workers tend the beds and bring vegetables, but are not on the household list. They asked her not to make them a public example; she wants their work counted as work. Her existing routines include practical exchanges with Thomas about wheat and seed keepers and with James about garden paths and water.

These starting accounts are asymmetric. A resident does not learn another's Equal Loaf account simply because it is in a shared story document. They can learn from the player or from nearby speech only when the engine records that hearing for them. Do not share another resident's private memory or unrevealed knowledge.

## Memory and world-state boundary

- Include only the selected resident's own available knowledge and recent heard-speech memory.
- Phrase remembered speech as something a named resident said. Do not silently promote it to verified fact.
- A resident can react, challenge a claim, adopt a belief, or make a promise. That conversational change is not a world-state mutation.
- The model has no game tools. A requested map edit, delivery, policy change, inventory change, or other action requires a separate engine-owned decision and execution path.
- The player's realization that the household count excludes garden workers belongs to the player. Do not inject it as a shared resident fact.

## Spatial conversation behavior

The viewer can play several residents as separate spatial voices. The engine selects the resident addressed at the start of each hold, binds that identity to the turn/session, and samples authoritative positions while their speech plays. The native client may submit only a completed provider input-transcription item through `/boson-ptt/player-speech/finish`, correlated to that active turn/session and provider item ID. The engine attributes it to the player and gives each resident who stayed within hearing range across the whole held turn a private, transient hearsay memory for that resident's next prompt. A resident who entered late or moved away is excluded. No raw microphone audio is fanned out and the transcript is not verified world truth. The player client cannot select a speaker or listener identity by supplying IDs or coordinates.

Push-to-talk is hold-to-speak. Microphone capture is active only during the hold; release ends capture and submits the turn. Residents continue their routines and the explorer remains navigable while the button is held. An interrupted or incomplete utterance is not projected as a complete heard statement. Resident sessions may persist across holds, but a new hold resolves its addressed resident from current world state; movement never transfers an active response to another resident.

## Historical scene boundary

The earlier authored Equal Loaf beat map and its line IDs remain useful as source material for each resident's starting knowledge. They are not runtime dialogue gates. The current scene has no requirement to finish in three minutes, visit each resident in order, use a fixed closing line, or limit conversation to the Equal Loaf. Adaptation proposals for map edits, public recognition, or policy changes remain proposals and are not engine actions unless separately implemented.
