# Living village mystery: design and prompt pack

Status: proposed narrative and implementation guidance. This is not a report of behavior already implemented.

## Experience goal

The player arrives in a village where life is already happening. Residents move between useful places, finish errands, exchange short remarks, and react to one another without waiting for the player to trigger a line. A quiet murder mystery has unsettled the village: people are guarded around the newcomer and sometimes keep them in view from a few blocks away. The player can stroll, listen, notice clues, or leave. The camera remains a close, heading-locked third-person view.

The murder is entirely off-screen and non-graphic. No resident attacks the player, the player is not presumed guilty, and no irreversible world change is required to explore the story. The mystery should feel like entering a community, not starting a dialogue menu or a combat encounter.

## What exists today

- `packages/minecraft/src/village-profiles.ts` defines three simulated residents—Anna the gardener, James the cartographer, and Thomas the baker—with three waypoint stops each.
- `packages/minecraft/src/village.ts` currently advances one authored dialogue turn at a time. It moves that speaker and listener, emits a chat/dialogue event, then waits 18–30 seconds. Routine movement and dialogue are therefore coupled, with long quiet gaps.
- `packages/minecraft/src/viewer-audio.js` presents local subtitles and speech and adjusts volume using the explorer’s distance from a dialogue event. No remote voice service is needed for this path.
- `docs/third-person-camera-research.md` describes a proposed camera that follows the explorer’s yaw and pitch. The camera work is separate from this narrative proposal.

These are repository facts. The story, schedule, suspicion behavior, and prompts below are proposals. Head tracking, gesture animations, path quality, and how accurately a browser viewer renders those actions still need implementation checks.

## Mystery: The Quiet Bell

The village bell keeper, Rowan, was found dead in the bell house before dawn. The scene is not shown; the bell simply did not ring, and the villagers are now keeping to familiar routes in pairs or within sight of home. Nobody knows the newcomer, so residents watch from a respectful distance and are reluctant to speak plainly.

**Authored answer:** Thomas killed Rowan during a private argument after Rowan discovered that Thomas had been diverting a portion of the winter flour stores. The act happened off-screen. Thomas is remorseful and frightened, but still hides the truth. The other residents have reasons to look suspicious and each holds one useful piece of the timeline. The player’s arrival is coincidental.

The crime is a fixed story fact, not something an LLM may change. The MVP does not need to simulate Rowan, a body, a weapon, or the act itself. A closed bell-house door, a stopped bell schedule, dialogue, and small environmental clues can carry the premise.

### Residents and dramatic function

| Resident | Everyday life | What they want | What they conceal / know | How they treat the player |
|---|---|---|---|---|
| **Anna, gardener** | Tends the west beds, carries seedlings uphill, checks the well | Keep the village fed and the gardens safe | Saw Thomas leave the bell-house path before dawn; initially withholds this because she fears a false accusation | Watches from a garden edge, turns back to work if approached too quickly; speaks more freely near her beds |
| **James, cartographer** | Updates route notes, checks the river gate, walks between map board and market | Preserve trustworthy records and prevent panic | His map shows the flour cart took an unusual detour; he did not record it immediately | Keeps the map between himself and the player; may invite the player to look from across the board |
| **Thomas, baker** | Tends the hearth, fetches grain, shares bread with neighbors | Protect the bakery and avoid being exposed | Diverted flour and killed Rowan after the argument; denies being at the bell-house | Tries to stay within sight of an exit, watches the player’s hands/approach, and changes subject when the bell or flour is mentioned |

The absent victim Rowan is described only through the missing bell, the closed bell-house, and neighbors’ memories. A later iteration can add residents, but three modeled villagers are enough to test this arc.

Give their voices different rhythms as well as different facts: Anna is practical and plain-spoken; James is precise and qualifies what he knows; Thomas is warm and lightly humorous until the bell or flour comes up. Example ambient lines:

- **Anna:** “Seedlings don’t wait for a quiet morning. I’ll tell you what I saw when the path is clear.”
- **James:** “The map records the cart’s route. It does not record who was driving it.”
- **Thomas:** “If the oven’s warm, people ask fewer questions. Funny how that works.”

### Clue progression

Clues are discoverable in any order; dialogue should react to what the player has already heard without making exploration mandatory.

1. **The silent morning bell:** all three residents mention that Rowan’s normal dawn bell did not ring. This establishes the event without a forced exposition scene.
2. **The flour ledger:** a discrepancy at the bakery suggests someone has been hiding shortages. It points toward motive but does not identify the killer by itself.
3. **The route mark:** James’s map and a muddy track show a flour cart used the path behind the bell-house that night. This puts more than one person near the scene.
4. **Anna’s sighting:** after a low-pressure conversation near the garden, Anna recalls seeing Thomas return from that path before dawn.
5. **Thomas’s contradiction:** Thomas first says the bakery was closed all night, then later mentions having relit the hearth after dawn. The contradiction becomes clear only when paired with the route and sighting.

At the final beat, the residents can discuss the gathered facts among themselves. The prototype can end on a conversation that acknowledges the evidence; it need not implement a confession, interrogation system, verdict, or branching ending. Never treat one ambiguous clue as proof.

## Activity that does not depend on conversation

Give each resident a small daily schedule and an independent activity loop. The schedule is deterministic for the MVP; dialogue is one layer over it, not its clock.

- Each resident follows a short morning / midday / evening route among role-specific places. Use staggered start offsets so all villagers do not travel together.
- While stopped, residents perform low-cost idle behavior: look toward nearby activity, turn back to a task, pause to listen, or exchange a brief ambient line. Only add gestures if the renderer supports them reliably.
- Trigger social exchanges from place, schedule, and story state. Residents can converse with each other while the player is far away; walking closer lets the player overhear the current exchange.
- When the player approaches, residents notice them, briefly look or orient toward them if supported, and preserve distance. They may continue their task, move toward a familiar nearby stop, or resume conversation with a companion.
- Avoid constant path recomputation. A resident should have at most one active destination; use a cooldown and a short deterministic choice among valid next actions.
- Keep routine movement, mystery state, and spoken lines in separate data. This allows frequent visible life without repeating the same exposition.

Suggested MVP pacing is a new ambient action every few seconds across the whole village, with each individual resident getting a meaningful route change roughly every 10–25 seconds. These are tuning starting points, not measurements from the current demo. Dialogue should be less frequent than movement, with long enough pauses for subtitles and local speech to finish.

## Wary but welcoming interaction

Use distance and sound as the main expression of mistrust. A resident may keep roughly 3–6 blocks of space, watch from a doorway or work area, and speak more audibly when the player is closer. If approached rapidly, they can pause, step toward a familiar place, or let a companion answer. They should not flee across the map or stare continuously.

Conversation should be ambient and proximity-aware:

- Exchanges begin between residents without waiting for the player.
- The viewer shows the current speaker and a short subtitle. Distance affects local speech volume; it must not make essential text inaccessible.
- Within the near range, a resident may offer a short opening or respond to a previously noticed clue. At a middle range, the player hears fragments. Beyond the range, no new subtitle is pushed to the player, though the world event may continue internally.
- Avoid subtitles cycling through every line regardless of distance. Do not restart a line on every proximity update.
- A direct conversational interaction can be added later; the MVP should work as a walk-and-listen experience.

Exact radii and the feasibility of reliable head turning are implementation questions. Start with distance bands and deterministic orientation toward the player, then inspect the same live viewer before tuning.

## Prompt pack

Prompts describe a future optional planner/controller boundary. For the first playable version, implement their constraints as authored data and deterministic rules. Do not call a paid or remote model by default.

### World planner (slow, optional)

```text
You are the continuity planner for a small village mystery. Treat the supplied
world facts, resident profiles, schedule, and evidence ledger as canonical.
Choose at most one low-stakes scene beat from the allowed list for the next
planning window. Prefer a beat that gives residents an ordinary reason to move,
talk, or notice the explorer. The explorer is a newcomer, not a presumed
suspect. Keep the murder off-screen and non-graphic. Never invent, destroy, or
move clues; never change the fixed culprit or motive; never make an accusation
without the evidence threshold specified by the story state.

Return only JSON matching:
{"beat":"...","participants":["..."],"place":"...",
 "prerequisites":["..."],"line_intents":["..."],"expires_in_seconds":30}

Allowed beats: routine_exchange, cautious_observation, clue_reaction,
private_conversation. If no beat is suitable, return {"beat":"wait"}.
```

Planner input should be a compact snapshot: in-game time, resident locations and current activities, player distance bands, already discovered clues, and recent scene beats. Keep the fixed answer and undiscovered clues out of any prompt sent to an untrusted or external service unless that service is explicitly approved for the project.

### Resident voice writer (slow, constrained)

```text
Write one short line for {resident_name}. Use only the supplied known facts,
relationship, current activity, and evidence state. Keep the voice consistent
with {personality}. The line should sound like something said to a neighbor,
not a quest marker. If the resident is wary, be guarded without threatening the
explorer. Do not reveal a clue this resident has not discovered. Do not invent
facts, accuse the player, mention game systems, or describe violence. Return one
spoken sentence, at most 18 words, or return SILENCE.
```

For the MVP, curate a small set of lines per state and select them with a seeded choice. A model can later paraphrase within a strict fact envelope; its text should be rejected or replaced with a safe authored fallback if it violates length or story constraints.

### Fast bounded controller (Jev-compatible, optional)

```text
You are a local real-time actor controller. Follow the current schedule and
scene beat. Choose only from: walk_to(approved_waypoint), stop, look_at(visible
entity), turn_toward(visible_entity), idle(approved_animation). Keep the
resident on walkable ground, within the village boundary, and at least
{minimum_player_distance} blocks from the explorer unless an explicit scene
beat permits closer conversation. Do not attack, dig, place blocks, open
containers, change inventory, send chat, invent objectives, or alter evidence.
If the next action is unclear or unsafe, choose stop and report blocked.
```

Use a local deterministic controller in the first version. If Jev becomes available and is explicitly configured, it may select or execute only these bounded movement/orientation actions. It does not decide story truth or write new executable scripts at runtime. The planner may issue a new short-lived beat asynchronously; controller actions expire and are revalidated against local bounds. A timeout or invalid action falls back to the deterministic routine.

## Staged implementation path

1. **Jev-free activity pass:** keep the current three Mineflayer actors; separate per-resident routine ticks from dialogue; stagger waypoint movement; add visible idle/orientation behavior only where the renderer supports it. Use a seeded schedule and authored lines.
2. **Mystery state:** add a small explicit state record for time, discovered clues, and completed conversation beats. Keep all evidence immutable and the culprit fixed. Add the silent-bell opening and the clue sequence above.
3. **Player awareness:** calculate distance bands locally from current positions. Trigger occasional wary observation and near-range exchanges with cooldowns; never spam subtitles or speech.
4. **Acceptance walk:** enter the village; see residents already doing different things; approach and overhear one exchange; observe a resident notice the player and keep some distance; revisit after a route change; collect clues in a different order; verify no accusation fires early. Inspect camera framing and subtitles in the existing live viewer.
5. **Optional Jev experiment:** only after local behavior is enjoyable, investigate whether a Jev runtime can be accessed and what its actual action, latency, licensing, and cost constraints are. Keep it behind an explicit configuration flag. The reported roughly 24 ms figure is deployment-specific and is not assumed to hold for Boson or an internet-connected setup.

## Evidence and unknowns

- **Repo evidence:** the current simulator is deterministic, uses three Mineflayer bots, has authored dialogue, and routes spoken events to the local viewer. See the source files listed above and `docs/minecraft-world.md`.
- **Design inference:** decoupling schedule movement from dialogue should make the village feel more active because the current 18–30 second wait occurs inside the single dialogue loop. This is a hypothesis to check in the viewer, not yet an observed result.
- **Unverified:** whether the viewer can render convincing villager head turns or gestures; whether ambient speech is audible at comfortable levels in the user’s setup; availability and integration requirements for Jev; and whether its advertised latency applies to any proposed deployment.
- **Safety boundary:** do not send player identity, voice recordings, or private project details to a remote planner by default. Do not incur model or media costs. A future Jev or LLM connection needs an explicit configuration and cost/credentials review.
