# Village story adaptations for discussion

**Status: DRAFT — discussion options, not story canon or an implementation plan.** This note supplements [the Quiet Bell story proposal](village-mystery-design.md). It does not choose or lock the next narrative direction.

## What makes Façade compelling beyond its technology

Façade makes the player socially consequential before asking them to master a system. The player is a longtime friend invited into a private evening; that role makes it plausible that two characters will bring the player into their conflict. The drama is about an intimate relationship, not about exploring a large world or completing a checklist. Its one-room, one-act scale concentrates attention on the couple, their competing accounts, and the guest’s reactions. Mateas and Stern describe a roughly twenty-minute experience whose many small player actions shape what happens and how the drama ends, instead of relying on a few conspicuous branch points. They also emphasize that the dramatic behaviors were hand-authored, and that limited content and imperfect language understanding remained real constraints. [Mateas & Stern, “Façade: An Experiment in Interactive Drama” (2003)](https://www.cp.eng.chula.ac.th/~vishnu/gameResearch/story_november_2005/MateasSternGDC03.pdf)

The transferable craft lesson is to make a small cast’s conflict matter to the player, then let compact dramatic beats connect local reactions to a legible ending. The beats need a dramatic purpose and state consequences; they are more than dialogue snippets. Façade’s authors describe beats as situation-specific collections of behaviors with preconditions and effects, sequenced to preserve a coherent overall experience while allowing room for player response. That content structure is useful as a design analogy, not a prescription to recreate its ABL/drama-manager architecture. [Mateas & Stern, “Structuring Content in the Façade Interactive Drama Architecture” (2005)](https://doi.org/10.1609/aiide.v1i1.18722)

Their authoring case study makes the relationship mechanism concrete: a small disagreement about drinks gives the guests an immediate social position to react to; character reactions accumulate into relationship and tension state; later beats can recall that pattern in a visible crisis. The everyday prompt matters because it lets the player take a side in the relationship, not because drink selection is an interesting puzzle. The authors also describe the authoring burden and the gap between broad player expression and a much smaller set of authored interpretations. [Mateas & Stern, “Writing Façade: A Case Study in Procedural Authorship”](https://electronicbookreview.com/publications/writing-facade-a-case-study-in-procedural-authorship/)

For Boson, the feasible version is a short social drama among three residents, in one village neighborhood, where the player’s choice of whom to approach, what to ask, and whether to follow up has consequences for trust, disclosure, and the residents’ next authored action. The current coarse semantic vocabulary means the story must not depend on an LLM recognizing subtle open-ended positions like irony, accusation, or negotiation. Those would require explicit authored semantics and tests.

## What Boson already has

- Three authored residents with distinct goals: Anna protects seedlings and food, James protects reliable route records, and Thomas protects the bakery and his reputation. Their nine routine stops include the shared `market-well` stop plus the garden, map, bakery, river-gate, seed-shed, and grain-store areas. See [village-profiles.ts](../packages/minecraft/src/village-profiles.ts).
- The Quiet Bell fact set: silent bell, flour ledger, route mark, Anna’s private sighting, Thomas’s denial, and later contradiction. The answer is fixed in [village-mystery-design.md](village-mystery-design.md), while private disclosure is gated in [village-cognition.ts](../packages/minecraft/src/village-cognition.ts).
- Typed per-resident memory, authored action-plus-line beats, an in-range player-intent event, recent player-request recall, a recipient-owned ambient-claim reaction, and a trust threshold for Anna’s sighting. The kernel and tests prove these components with synthetic events.
- A vanilla plains village from seed `244`, with a datapack that sets world spawn on an open village path. The repository contains no bespoke story props, animated evidence, or custom village art. See [minecraft-world.md](minecraft-world.md) and `config/minecraft/world-packs/boson-village-spawn/`.

The mechanism proves bounded responses, memory and gates; it does not prove either complete story below. Routine stop names are semantic targets, not evidence that a physical map, ledger, bread basket, or meeting table has been built as an interactive prop. The current player intent set is `greet`, `ask_about_known_topic`, `ask_for_help`, `leave`, and `unknown`; it has no explicit accuse, share-evidence, bargain, take-sides, or resource-allocation act. See [village-vocabulary.js](../packages/minecraft/src/village-vocabulary.js).

## Option A — The Quiet Bell: A Meal Without an Accusation

**Area:** one connected garden-to-market-well neighborhood. Use the existing `west-garden`, `seed-shed`, and `market-well` stops as authored scene anchors; keep the experience within a short walk. This is a proposed staging area, not a claim that those props or exact geography already exist.

**Target length:** 10–15 minutes.

**Player role and stakes:** the newcomer has been invited to help the seed keepers prepare the evening bread-sharing. Anna, James, and Thomas each need something from the newcomer before the meal: practical help, a reliable account of the cart route, or someone willing to hear the bakery’s side. If the group turns an uncertain timeline into a public accusation, the shared work and a new neighbor’s welcome both fail. If they preserve uncertainty, the meal can happen while the investigation stays open.

**Dramatic question:** can the player help three guarded neighbors share what they actually know without treating one clue as proof?

### Beats

1. **Welcome with a problem.** Anna asks the player to help prepare the garden-side meal. James mentions that the dawn bell was silent; Thomas arrives with a warm offer of bread but changes the subject when flour comes up. The routines continue around the conversation.
2. **Choose where to spend attention.** The player can help Anna in the garden, ask James about the route, or ask Thomas about the shortage first. This changes which resident has the first private exchange and which public fact is heard next; it does not change canonical truth.
3. **James’s qualification.** At the map-side edge of the neighborhood, James shares the route mark and is precise that a route does not identify its driver. The player can accept that limit and keep the meal moving, or return to the question later after hearing another account.
4. **Anna’s practical request.** A player who asks for garden help is remembered by Anna. After a respectful exchange and a later garden greeting, the existing recent-intent beat can pause her routine and invite the player to check the seedlings. At sufficient trust, and only in the garden on a garden topic, Anna may disclose the sighting of Thomas.
5. **Thomas’s account.** Thomas says he stayed at the bakery; his warm hospitality conflicts with his guardedness about the missing flour. The player can ask about the known shortage or leave him room to continue the meal preparation. No single line proves guilt.
6. **The contradiction.** Only after Anna’s disclosure beat, Thomas’s later statement that he returned after dawn can become available. The player now has a motive clue, a route clue, and a contested timeline, with their sources kept distinct.
7. **Close the evening.** An authored ending beat reflects the evidence and relationship state. With enough corroboration, the neighbors agree to share a careful account and continue the inquiry together. With incomplete evidence, the meal still happens but the question remains open. If the player repeatedly presses a resident without the trust/location prerequisites, that resident returns to work and the player leaves without the private account.

### Choices and consequences

- Visit order changes which public facts and relationships are encountered first; it should not create a required clue order.
- Helping Anna has a concrete local consequence: she pauses her route and later shares only the clue she is authorized to disclose.
- Respecting James’s “route, not driver” boundary preserves his willingness to clarify the map later. Pressing him for an accusation should get a guarded authored response, not new evidence.
- Asking Thomas about the shortage can expose his existing denial/contradiction sequence only when the authored prerequisites allow it.
- The ending differentiates “careful shared account,” “meal with unresolved question,” and “conversation closed by mistrust.” A murder verdict is not required for a satisfying end.

**Solvability rule:** the culprit is not inferable from the silent bell or shortage alone. A careful account requires at least two independent sources among the route mark, Anna’s private sighting, and Thomas’s later contradiction; the flour ledger adds motive but does not identify a driver. The ending must state what remains uncertain.

**Fit and missing pieces:** this preserves the current residents, goals, facts, routines, Anna’s trust/location gate, recent garden-help memory, and authored responses. The authored routines and mystery lines need to be shaped into a timed 7-beat social arc. Missing mechanics are a beat/ending director, an explicit local “share a careful account / keep it private” choice, and ending state/epilogue lines. Do not ask a model to infer accusation, guilt, or evidence sufficiency from free text.

## Option B — The Last Flour Share

**Area:** the shared `market-well` stop and its immediate path. All three resident profiles already route through `market-well`; use it as a small social stage. This is a design target, not a verified common physical coordinate for all three bots.

**Target length:** 10–15 minutes.

**Player role and stakes:** the player is the newcomer Thomas promised to feed during their first evening in the village. A shortage means the final flour share can support either the bakery’s promised loaf or Anna’s seed-keeper meal, but not both at full size. James has to decide whether his public map note can support another delivery. The player’s first welcome depends on whether the neighbors can make a fair plan together.

**Dramatic question:** can the player help Anna, James, and Thomas make a fair use of the remaining flour without turning a shortage into a contest over whose account is trustworthy?

### Beats

1. **The promise.** At market-well, Thomas welcomes the player and discovers the flour shortage means he cannot fulfill both bread promises. Anna needs food for the seed keepers; James says the map alone cannot prove why the sacks are missing.
2. **Hear the needs separately.** The player chooses to ask Thomas about bakery work, Anna about the garden, or James about the route. The first response emphasizes that resident’s goal; the other two continue their routines and may overhear the coarse semantic request if in range.
3. **A route without a culprit.** James shares the route mark but states its limits. The player can ask him to keep the map entry precise or ask what would make a future route reliable.
4. **A private burden.** Anna asks for garden help, and a later trust-eligible greeting carries the earlier request forward. Thomas hears the player ask about the bakery and, if the player gives him time, acknowledges the pressure without changing the story into a confession.
5. **The share.** The residents each state a practical proposal: bakery first, seed keepers first, or split the share and accept a smaller loaf/meal. The player’s explicit authored choice resolves which plan is tried.
6. **Test the plan.** James identifies whether the selected plan has a plausible route; Anna and Thomas react according to their goals and relationship with the player. A route problem leads to an authored compromise, not an invented fact.
7. **Welcome or distance.** The shared plan produces a first loaf and a clear welcome, or an unresolved disagreement leaves the player with a smaller individual portion and a visible social distance. Either way, the immediate promise is resolved for tonight; the flour shortage can remain for another story.

### Choices and consequences

- The player chooses whose need to hear first, which changes trust and whose practical detail is available before the allocation.
- The final split is a meaningful authored decision: bakery-first protects Thomas’s public promise; garden-first protects Anna’s seed keepers; a split protects the relationship but leaves both needs partly unmet.
- James’s route note can raise or lower confidence in the plan, but he cannot name a driver from a map mark.
- The ending is legible and finite: the group tries a chosen allocation tonight, and the player receives either the promised loaf, a shared smaller meal, or an explicit unresolved promise.

**Solvability rule:** there is no killer puzzle. The player should be able to identify the actual shortage and the route constraint by asking any one resident plus James; no hidden mandatory clue is required. Success means making a feasible, acknowledged plan, not finding a culprit.

**Fit and missing pieces:** this uses the existing everyday goals, market-well routine stop, topic/intent classification, recipient-local memory, relationship values, and authored line/action selection. The existing Quiet Bell evidence and fixed-murder knowledge cannot be silently reused as the explanation for the shortage. This option needs a separate non-murder scenario ledger, an allocation choice surface or typed player act, an authored world-state effect for the chosen share, and end-state relationship responses. It is the larger story/mechanics change.

## Recommendation for discussion

**Prefer Option A for the next small story slice, pending owner discussion.** It already has the stronger working foundation: three resident goals, a fixed evidence set, public/private knowledge boundaries, trust/location gates, and a new recent-request callback. The draft changes the dramatic center from “collect clues to name a culprit” to “help neighbors decide what they can responsibly say to one another,” preserving the existing mystery while giving the player a social stake. Its main new requirements are a small authored ending selector and one explicit evidence-sharing choice.

Option B is a credible alternative if the team wants to pivot away from murder and center an everyday resource decision. It offers clearer immediate stakes and a cleaner non-violent ending, but it requires a separate story ledger and an actual choice/effect surface; it should be treated as a new scenario rather than a minor rewrite of Quiet Bell.

Both options remain proposals. The mechanisms listed as missing need an implementation estimate and a deliberate story decision before either adaptation is treated as committed scope.

## Sources

- Mateas, M., & Stern, A. (2003). [“Façade: An Experiment in Interactive Drama”](https://www.cp.eng.chula.ac.th/~vishnu/gameResearch/story_november_2005/MateasSternGDC03.pdf). GDC 2003. Primary author paper.
- Mateas, M., & Stern, A. (2005). [“Structuring Content in the Façade Interactive Drama Architecture”](https://doi.org/10.1609/aiide.v1i1.18722). Proceedings of the First AIIDE Conference, 1(1), 93–98. Primary author paper.
- Mateas, M., & Stern, A. [“Writing Façade: A Case Study in Procedural Authorship”](https://electronicbookreview.com/publications/writing-facade-a-case-study-in-procedural-authorship/). Author case study.
