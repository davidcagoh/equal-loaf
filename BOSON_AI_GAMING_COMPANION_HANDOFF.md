# Boson AI Hackathon — AI Gaming Companion

**Handoff specification | 23 October 2026 | Status: proposed, not implemented**

**Owner:** Solo builder/presenter using coding agents. **MVP:** Minecraft Java Edition. **Moonshot:** Overcooked-like cooperative kitchen. **Pitch:** *An AI friend who doesn't just talk about games—it plays alongside you.* **Tagline:** *Different games. Same friend.*

## 1. Executive decision and goals

Build a voice-first AI teammate that observes a shared game world, converses naturally, takes actual actions, changes plans when interrupted, and displays a recognizable personality. Ship a reliable Minecraft demonstration before attempting the kitchen-game stretch goal. Deliver a compelling 60–90-second recorded video and a constrained live judge interaction. Optimize first for memorable hackathon demonstration, second for a reusable commercial companion platform.

**Minimum proof:** Say “Follow me”; bot follows. Interrupt with “Stop—come back!”; bot stops the previous action and returns. Companion audibly acknowledges the change. This must work live, not as a scripted animation.

**North-star sequence:** “Help build a house” → companion collects wood → player shouts “Help, I'm dying!” → companion interrupts collection and helps or retreats → it recalls the house goal and proposes the next step. This is a target, not existing functionality.

## 2. Discussion and decision history

The conversation started by examining the Boson AI 2025 hackathon, its winners, competitiveness, and what might win. We explored sales/negotiation agents, interpreters, moderators, TTRPG dungeon masters, Codenames, Decrypto, social deduction, murder mysteries, and expressive-character demos. Core discovery: a compelling project should demonstrate an unmistakable audio-native capability, produce an observable result in under a minute, be feasible for one operator supported by coding agents, and have a plausible business continuation.

Social games are compelling because they involve hidden information, speaker tracking, interruptions, and strategic conversation, but their key intelligence can sometimes be reproduced in text. A gaming companion makes **voice coordination change real actions in a shared world**. Minecraft was selected for its mature bot ecosystem and expressive open-ended cooperation; Pokémon/Showdown was considered simpler but less compelling as cooperative play; Smash-like direct control was judged riskier. Overcooked-like play is the stretch target because spoken task coordination under time pressure is essential to gameplay.

**Source caveat:** Earlier conversation included inconsistent claims about exact 2025 prize placements. Verify winners, event rules, judging categories, and API claims against official primary sources before citing them publicly. Proposed scoring weights are strategy, not an official rubric.

## 3. Priorities and scope

| Priority | Requirement | Acceptance |
|---|---|---|
| P0 | Minecraft bot connects | Visible in prepared Java world |
| P0 | Spoken follow | Starts following player |
| P0 | Spoken stop / redirect | Existing action cancels; new action starts |
| P0 | Spoken feedback | Companion confirms what it actually did |
| P0 | Personality | Recognizable, concise, context-sensitive voice |
| P0 | Demo reliability | Repeatable prepared scene; video captured |
| P1 | Gather wood | Collects logs from reachable tree |
| P1 | Give item | Transfers/drops item near player |
| P1 | Respond to danger | Defends or retreats in controlled scenario |
| P1 | Shared goal memory | Recalls/resumes task after interruption |
| P1 | Status overlay | Shows current goal, speech, action state |
| P2 | Kitchen-game adapter | Completes a cooperative spoken task switch |
| P2 | Cross-game persona | Same personality and planner in both games |

**Non-goals:** Completing Minecraft, unrestricted game mastery, training a new control model, frame-perfect movement, arbitrary-game generality, complex persistent memory, reliable multiple-speaker diarization, full 3D avatar, or a production backend. Do not build these at the expense of P0.

## 4. Architecture

```text
Human speech ─► Boson voice interface ─► intent / conversation layer
                                               │
Game observation ─► state summarizer ──────────►│
                                               ▼
                                     companion social policy
                                     persona + shared goals
                                               ▼
                                    strategic goal scheduler
                                     priority + cancellation
                                               ▼
                                        typed GameAdapter
                                         /           \
                             Minecraft/Mineflayer   Kitchen [P2]
                                         \           /
                                        game observations
```

**Layer responsibilities:** Voice handles microphone, streaming speech recognition/conversation/synthesis, and interruption where supported. Social policy decides what to say, whether speech implies a goal, and when to initiate help. Strategic policy chooses a small number of skills and priorities. Tactical controllers handle deterministic pathfinding, movement, inventory, and simple defense. Game adapter validates and executes typed goals. Scheduler owns cancellation and goal lifecycle independently of voice latency.

A conceptual policy is `π_social(g_next, utterance | game_state, dialogue_history, current_goal)`, while `π_game(action | game_state, goal)` chooses legal actions. Rank candidate goals by urgency, usefulness, and switching cost, with explicit safety/stop overrides. This is an engineering heuristic, not an optimality claim.

### Typed contract proposal (TypeScript)

```ts
type Priority = 'emergency'|'user'|'proactive'|'background';
type GoalKind = 'follow'|'stop'|'approach'|'gather'|'give'|'defend'|'retreat'|'report';
type Goal = {id:string;kind:GoalKind;priority:Priority;args:Record<string,unknown>;source:'voice'|'world'|'agent'};
type Status = 'queued'|'running'|'completed'|'cancelled'|'failed';
type Observation = {timestamp:number;game:string;player?:{position?:[number,number,number];health?:number};agent?:{position?:[number,number,number];health?:number};threats?:unknown[];inventory?:Record<string,number>};
interface GameAdapter {
  connect():Promise<void>;
  observe():Promise<Observation>;
  capabilities():GoalKind[];
  execute(goal:Goal,signal:AbortSignal):Promise<{status:Status;detail?:string}>;
  disconnect():Promise<void>;
}
```

Normalize events: `audio.input → transcript/intent → goal.proposed → goal.accepted → action.started → action.completed|cancelled|failed → speech.response`. Include timestamps, goal IDs, status, latency, and failure reasons. Only whitelisted intents reach the game executor; never execute unrestricted model-generated code or shell commands.

### Interrupt and scheduling rules

1. `stop` is processed locally at highest priority, clears movement controls, and cancels the active skill.
2. Emergency goals preempt background, proactive, and ordinary user goals.
3. A new incompatible user goal replaces the old one; compatible goals may queue.
4. Propagate `AbortSignal` to long-running skills; acknowledge cancellation only when it actually occurs.
5. Preserve shared objectives separately from current tactical actions so a task can resume after danger.
6. Suppress stale completion events and duplicated actions; apply timeouts and recovery states.

## 5. Minecraft implementation

**Candidate stack:** Minecraft Java local/test server, Node.js/TypeScript, [Mineflayer](https://github.com/PrismarineJS/mineflayer), [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder), a minimal browser status overlay, and the current supported Boson Higgs voice API. Verify Minecraft/library version compatibility, credentials, quotas, and licensing before starting.

Prepare a reproducible test world: flat/open spawn area, known player and bot spawn, reachable trees, optional controlled hostile mob, no hazardous terrain, recorded seed and server settings. Keep a reset script. Implement in order: connect → follow → stop → return → voice acknowledgement → gather → give → danger response. Make action status truthful: if gathering fails, the companion says so rather than pretending success.

**Voice integration:** Verify current Boson model names, supported streaming protocol, ASR/TTS/speech-to-speech modes, interrupt semantics, tool calling, and rate limits in documentation. Do not invent endpoints or assume native diarization/emotion recognition. Separate voice-to-action latency from voice-to-first-audio latency. Maintain game control when speech synthesis is slow; offer push-to-talk fallback if open-mic interruption is unreliable.

## 6. Overcooked-like moonshot

Implement one small cooperative kitchen: two players, two ingredients, one recipe, fixed stations, a timer, and simple grid navigation. Consider a custom browser game or [Overcooked-AI](https://github.com/HumanCompatibleAI/overcooked_ai) after verifying its suitability/license; avoid automating the commercial game. Reuse the **same** social policy, typed goals, scheduler, and voice system, replacing only the adapter and deterministic tactical controller.

**Demo:** “Get the onions” → AI fetches → “Wait, soup's burning!” → AI changes course → “I'll handle the onions; you plate it!” → AI coordinates. Only start this after Minecraft follow/stop/return works and its demo is recorded. A fake kitchen animation does not satisfy the stretch goal.

## 7. Coding-agent workstreams

| Workstream | Deliverable | Test |
|---|---|---|
| A. Game integration | Server, Mineflayer bot, pathfinding, actions | Scripted follow/stop/return |
| B. Voice | Boson client, mic, audio playback, transcript events | Voice round-trip + barge-in/fallback |
| C. Companion | Intent schema, personality, scheduler, cancellation | Deterministic goal transition tests |
| D. Demo | Status overlay, reset scripts, recording, demo scene | Repeatable 90-second capture |
| E. Kitchen [P2] | Small kitchen + adapter | One genuine spoken task switch |

**Integration rule:** Agree on shared contracts first. Each agent owns a bounded module and tests; only one integration owner merges changes. Do not allow coding agents to independently redefine event names, action semantics, or the demo's scope. The human owner focuses on live testing, selling the narrative, recording, and final prioritization.

**Suggested repo:**

```text
README.md
HANDOFF.md
apps/demo-ui/
packages/contracts/
packages/voice-boson/
packages/companion-policy/
packages/goal-scheduler/
packages/game-minecraft/
packages/game-kitchen/      # stretch
scripts/start-demo.sh
scripts/reset-world.sh
tests/contracts/
tests/integration/
docs/demo-script.md
docs/decisions.md
```

## 8. Milestones, gates, and time budget

Suggested **24-hour effort allocation**, not a guarantee or event schedule:

| Phase | Budget | Exit gate |
|---|---:|---|
| Verify docs / setup / contracts | 2 h | Minecraft server + bot connected; API feasibility confirmed |
| Deterministic Minecraft skills | 5 h | Follow, stop, return work without voice |
| Voice + scheduler integration | 5 h | Spoken follow and interruption work end-to-end |
| Personality + one P1 skill | 3 h | One genuinely useful cooperative sequence |
| UI, testing, video, rehearsals | 5 h | Reliable video + controlled live demo |
| Stretch or contingency | 4 h | Kitchen slice **or** hardening, never at cost of MVP |

**Hard gates:** If Mineflayer fails early, troubleshoot version compatibility and simplify the world; do not proceed to broad game actions. If Boson realtime is unstable, preserve the real game loop with push-to-talk and supported separate recognition/synthesis components. If combat is unreliable, demonstrate stop/return and resource gathering. If the kitchen stretch is not genuinely functional, omit it from the video and pitch as roadmap only.

## 9. Acceptance test suite

| ID | Test | Pass criterion |
|---|---|---|
| T01 | Bot connection | Joins prepared server, observable state received |
| T02 | Follow | Approaches player while player walks along clear path |
| T03 | Stop | Explicit stop terminates active navigation; no automatic restart |
| T04 | Redirect | Gather/follow can be preempted by return-to-player |
| T05 | Voice | Spoken instruction produces correct typed intent and action |
| T06 | Speech grounding | Reply accurately reflects action success/failure |
| T07 | No stale actions | Late callbacks do not restart cancelled goal |
| T08 | Recovery | Disconnect/error yields clear status and safe retry |
| T09 | Prepared demo | Entire scene succeeds in repeated rehearsals |
| T10 | Judge input | Supported unplanned instruction works without changing code |
| T11 [P1] | Shared goal | Can report interrupted house/wood objective |
| T12 [P2] | Kitchen | Voice redirects teammate in real kitchen simulation |

Record actual latency distributions and rehearsal success counts rather than inventing performance metrics. Set operational thresholds after first baseline measurement; prioritize reliable action over arbitrary low-latency promises.

## 10. Demo and judging strategy

**Opening hook:** “This is not an NPC I talk to. This is a friend who plays with me.”

**60–90-second video storyboard:** (0–10s) show Minecraft player and companion; (10–25s) ask it to follow and collect wood; (25–45s) sudden interruption/danger, visible reprioritization; (45–60s) companion remembers the shared goal and suggests a next step; (60–75s) optional genuine kitchen cutaway if completed; (75–90s) tagline and compact architecture reveal. Use real captured interactions; do not imply edited sequences are uninterrupted real-time footage.

**Live demo:** Start from a resettable world. Show a known-good instruction, then invite a judge to choose from a small set of supported prompts or give a reasonable variation. Display current goal and action status to make the behavior legible. Have a prerecorded successful capture ready if networking or game setup fails, clearly labeled as a recording.

**Judging hypothesis:** High wow factor, visible voice-driven action, graceful interruption, polished presentation, and a believable technical explanation matter. No official scoring rubric has been verified here. Suggested internal screening weights from discussion: demo impact 30%, distinctive audio 25%, feasibility 20%, novelty 15%, commercial potential 10%.

## 11. Risks and mitigations

- **Game integration instability:** pin versions, use a local prepared world, deterministic navigation and reset scripts.
- **Voice latency or outages:** keep game controller independent; push-to-talk or staged speech pipeline fallback.
- **False ASR / accidental triggers:** explicit intent schema, confirmations for destructive actions, priority-aware interruption.
- **Hallucinated game state:** ground dialogue in adapter observations and action-result events.
- **Unreliable combat:** choose controlled escape/return as emergency proof rather than promising victory.
- **Excessive scope:** hard gate kitchen development; ship Minecraft first.
- **Demo failures:** record working video early, rehearse, keep local logs and recovery scripts.
- **Commercial/legal considerations:** validate platform rules for game bots, voices and recordings; do not imitate real people's voices without consent.

## 12. Commercial hypotheses and validation

**Hypothesis:** Players will value a persistent conversational teammate across games for companionship, cooperation, coaching, and accessibility. These are distinct segments, not one validated market. Potential customers include players, game studios, and developers seeking a companion SDK. The reusable asset is the game-independent social/goal policy plus adapter interface.

**Post-hackathon tests:** Conduct 5–10 observed sessions; measure repeat voluntary use, interruptions, moments of perceived companionship, failed actions, and whether users prefer competent assistance or expressive personality. Test willingness to pay and distribution through creator demos, game communities, or developer integrations. Avoid claiming product-market fit based on hackathon enthusiasm.

**Longer-term path:** Minecraft companion → kitchen coordination proof → second real game adapter → reusable SDK/consumer companion. The game-general thesis is only supported when a second adapter genuinely works.

## 13. Immediate next actions

1. Verify Boson API documentation, event rules, credentials, and available models.
2. Confirm local Minecraft Java/server version and Mineflayer compatibility.
3. Create repository and shared contracts; assign agents A–D.
4. Make follow/stop/return work **without voice**.
5. Integrate voice and test interruption end-to-end.
6. Record a minimal working video **before** adding complex skills.
7. Add one meaningful cooperative task, rehearse and harden.
8. Attempt kitchen adapter only after MVP and video gates pass.

## 14. Agent kickoff instruction

> Implement the Minecraft-first AI Gaming Companion described in this handoff. Preserve the P0/P1/P2 priority boundaries. Begin by validating current Boson API and Mineflayer compatibility, then create shared contracts and a deterministic Minecraft follow/stop/return controller. Implement a cancellable priority scheduler and connect real voice input/output. Make no claims of functionality without running the acceptance tests. Keep an updated `docs/decisions.md`, a concise status log, and a list of blocked dependencies. Do not begin the kitchen stretch until the Minecraft voice-interruption demo works and is recorded. Optimize for a reliable, compelling live demonstration, not general game-playing capability.

**Definition of done:** A real human speaks to a real AI companion that visibly performs and interrupts actions in Minecraft, with a reliable captured demo and a reproducible setup. Everything else is optional.
