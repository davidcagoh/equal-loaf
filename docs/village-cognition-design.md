# Village cognition: authored beats with reactive residents

Status: design proposal; no simulator behavior is implied to exist beyond the current deterministic routines and authored dialogue.

## Design intent

Make the village react to what its residents can observe and remember. Each resident has an ordinary goal, private knowledge, and changing relationships. A local beat selector chooses a short-lived authored intent from current events and eligibility. The actor's bounded movement and its spoken intent come from that same choice, so a character does not walk to one scene while saying a line from another. The simulation remains useful without a language model or PTT input.

## Present baseline

`village-profiles.ts` has three identities, three routine stops each, nine ambient lines, and six fixed mystery lines. It does not encode goals, belief access, relationships, or observation history. `village.ts` starts independent route loops, but one sequential dialogue loop rendezvouses actors and waits eight seconds after each line. `village-ai.ts` may choose a small movement verb from resident/activity strings; its dialogue adapter can select among authored line IDs. Neither interface represents perceived events or private knowledge. `docs/village-mystery-design.md` already defines Quiet Bell, clue order flexibility, safe player treatment, and the mystery's fixed answer; preserve it as story canon.

## Minimal cognition model

Represent cognition as local, explicit data, not free-form model state:

- **Goal:** one ordinary near-term purpose, such as Mira protecting the seedlings or Tobin maintaining a reliable route map. Goals explain routine choices; a beat can temporarily suspend one and then expire back to it.
- **Private knowledge:** separate canonical world facts from resident memories of claims. Authored truth stays in a protected story ledger; each resident's knowledge contains only witnessed facts or heard claims, with source, confidence, time, and disclosure conditions. Hearing an allegation records “resident X said Y,” not that Y is verified. Observation events update only residents who were participants or in the specified audibility/range/time window. Hidden story truth is never copied into every resident's state.
- **Relationship:** small bounded values or named bands per resident pair/player (e.g. unfamiliar, cautious, trusted), changed only by authored local events. No model decides relationship state.
- **Memory:** a compact set of observed event IDs and completed beat IDs, to prevent repetition and support later callbacks. Keep it in memory for the MVP; save/load is a later question.
- **Beat intent:** authored ID, participants, location, prerequisites, knowledge required, expiry/cooldown, dialogue intent, and one or more allowed actions. Select deterministically from eligible candidates with a seed and stable tie-break order.

One transition should have this shape:

`observed event -> eligible residents' private memory update -> beat eligibility -> selected intent -> bounded action + line intent -> event emitted`

Player speech is an observed event after the explicit talk control and transcription. Deliver its semantic event to every in-earshot eligible resident independently so each can record only that the explorer made the claim; prioritize the nearest eligible resident to take the immediate reply turn. Do not turn response priority into exclusive knowledge delivery. Keep speech transport, transcript/audio retention policy, and speech synthesis outside this reducer. Ambient resident events also enter the same path. Apply per-resident reply cooldowns. Actor routines continue on their own cadence while an optional model request is pending; late results expire and are discarded. Drop stale intents and re-check range, path bounds, and eligibility before applying actions.

## Authored versus generative responsibility

Authored data owns mystery truth, who knows each clue, disclosure thresholds, beat order constraints, speaker/listener, response options, and actor-action allowlists. Deterministic rules own sensing, memory updates, eligibility, cooldowns, action validation, and speech rendering. A scoped model may classify the transient PTT transcript into a bounded player intent/topic and choose a response ID from the selected resident's disclosure-safe `responseOptions`. The local selector maps that ID to an eligible authored beat and derives the action; the simulator renders the authored line text. Unknown IDs, hidden clue IDs, and any model-supplied prose are rejected in favor of the deterministic authored response. The model cannot grant knowledge, rewrite beliefs, identify the culprit, accuse the player, or issue a Minecraft command.

## First playable scenario: Quiet Bell, one short scene

1. The explorer arrives during the residents' ordinary morning loops. Mira tends the west beds, Tobin checks the map board, and Pip works near the bakery; these routes continue without dialogue being due.
2. An ambient beat lets the explorer overhear that Rowan's dawn bell did not ring. Later, Tobin and Pip discuss the flour ledger shortage. These facts are public clues, not a forced quest sequence.
3. The explorer uses the explicit talk control near Mira. Transcription yields a semantic event delivered to every eligible resident in earshot; each records that claim independently. Mira is nearest and gets reply priority. Her response is guarded because the player is unfamiliar; it reflects Mira's seedling-protection goal and does not reveal her private sighting. Residents outside range do not learn the claim.
4. After a low-pressure exchange near Mira's garden, a locally authored trust/scene condition becomes eligible. Mira chooses to tell the explorer that she saw Pip returning by the garden path before dawn. Her movement to/within the garden and the spoken line share the same intent.
5. A later overheard bakery exchange gives Pip's timeline contradiction. It is corroboration, not a verdict. The scene ends with residents continuing their day; no mandatory accusation, confession, or combat.

For component acceptance, the core reducer can be exercised with synthetic typed events and authored utterance events. That does not satisfy live-experience acceptance: the eventual Quiet Bell demo includes an explicit PTT exchange, residents' independent in-earshot reactions, and subsequent clue disclosure only when conditions are met. The live acceptance slice keeps routine movement active and makes the nearest resident's spoken response and bounded social/action intent coherent.

## Local implementation issue proposals

1. **Model resident goals, private knowledge, relationships, and typed observations.** Add focused profile/state types and a pure reducer; define tests for visibility, knowledge isolation, bounded trust changes, and duplicate events. No source behavior calls external AI.
2. **Select authored reactive beat intents and execute them as a unit.** Separate beat selection from routine cadence; add eligibility, cooldown/expiry, seeded deterministic choice, and action/line-intent emission from one selected beat. Preserve the JSONL `village.dialogue` contract.
3. **Connect explicit player utterances and overheard events to resident cognition.** Deliver a typed semantic event to all in-earshot eligible residents for independent observation, while prioritizing the nearest eligible resident for an immediate reply; ensure response choices use only each resident's accessible knowledge and relationship. Coordinate viewer/PTT ownership with `.28.10`, `.30`, and `.31` before wiring transport.

## Acceptance

- Each modeled resident has an explicit ordinary goal and private knowledge; at least one relationship value can change through authored events.
- Resident knowledge distinguishes a witnessed event or heard claim from canonical world truth; tests verify claim attribution and cross-resident knowledge isolation across in-earshot and out-of-range listeners.
- Independent routine movement continues while beat selection or dialogue is idle, and while optional model requests are pending or late.
- In-earshot eligible residents independently receive one semantic event; the nearest eligible resident receives response priority. Per-resident cooldowns prevent repeated reactions.
- A typed observed event can make one authored beat eligible; before/after state yields different resident behavior.
- A selected beat determines both an allowlisted action and a bounded utterance intent; validation/failure falls back to the routine and authored line.
- Identical initial state, event sequence, and seed produce the same beat/action/line intent.
- No model receives hidden solution facts or controls world truth/actions. A model may return only a bounded player intent, topic, and response ID from the selected resident's safe option list; all spoken text is rendered from local authored content.
- Component tests can inject synthetic typed events. The live Quiet Bell slice separately supports PTT, overhearing, independent reactions from in-earshot residents, a nearest-resident guarded Mira response, and later clue disclosure only when its conditions are met.

## Research and adaptation notes

- Mateas and Stern, [“Structuring Content in the Façade Interactive Drama Architecture”](https://ojs.aaai.org/index.php/AIIDE/article/view/18722), describes thousands of joint dialog behaviors organized into story beats and sequenced by a drama manager. The useful scale-appropriate idea is the beat as a plot/character unit with preconditions and effects, not Façade's full ABL machinery.
- Mateas and Stern, [“Façade: An Experiment in Building a Fully-Realized Interactive Drama” (GDC 2003)](https://faculty.cc.gatech.edu/~isbell/reading/papers/MateasSternGDC03.pdf), describes autonomous characters coordinated with a higher-level drama manager. Boson should keep that separation small and local: routine/character choice remains autonomous within bounds; authored beat eligibility protects the mystery arc.
- Mateas and Stern, [“Towards Integrating Plot and Character for Interactive Drama” (AAAI Fall Symposium 2000)](https://aaai.org/papers/0021-fs00-04-021-towards-integrating-plot-and-character-for-interactive-drama/), motivates the dramatic beat as the integration point between plot and believable-agent behavior.
- [rmalde/minecraft-agent](https://github.com/rmalde/minecraft-agent) demonstrates separating planning from bounded action selection and milestone-triggered planning. GitHub reports no license, so treat it as a conceptual reference only; do not copy or port its code. Boson's current local/optional planner already adopts a bounded-action boundary, but its current inputs do not yet represent story cognition.
