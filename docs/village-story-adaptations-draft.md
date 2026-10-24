# Village story adaptations for discussion

**Status: DRAFT — discussion options, not story canon or an implementation plan.** This note supplements [the Quiet Bell story proposal](village-mystery-design.md). It does not choose or lock the next narrative direction.

## What makes Façade compelling beyond its technology

Façade makes the player socially consequential before asking them to master a system. The player is a longtime friend invited into a private evening; that role makes it plausible that two characters will bring the player into their conflict. The drama is about an intimate relationship, not about exploring a large world or completing a checklist. Its one-room, one-act scale concentrates attention on the couple, their competing accounts, and the guest’s reactions. Mateas and Stern describe a roughly twenty-minute experience whose many small player actions shape what happens and how the drama ends, instead of relying on a few conspicuous branch points. They also emphasize that the dramatic behaviors were hand-authored, and that limited content and imperfect language understanding remained real constraints. [Mateas & Stern, “Façade: An Experiment in Interactive Drama” (2003)](https://www.cp.eng.chula.ac.th/~vishnu/gameResearch/story_november_2005/MateasSternGDC03.pdf)

The transferable craft lesson is to make a small cast’s conflict matter to the player, then let compact dramatic beats connect local reactions to a legible ending. The beats need a dramatic purpose and state consequences; they are more than dialogue snippets. Façade’s authors describe beats as situation-specific collections of behaviors with preconditions and effects, sequenced to preserve a coherent overall experience while allowing room for player response. That content structure is useful as a design analogy, not a prescription to recreate its ABL/drama-manager architecture. [Mateas & Stern, “Structuring Content in the Façade Interactive Drama Architecture” (2005)](https://doi.org/10.1609/aiide.v1i1.18722)

Their authoring case study makes the relationship mechanism concrete: a small disagreement about drinks gives the guests an immediate social position to react to; character reactions accumulate into relationship and tension state; later beats can recall that pattern in a visible crisis. The everyday prompt matters because it lets the player take a side in the relationship, not because drink selection is an interesting puzzle. The authors also describe the authoring burden and the gap between broad player expression and a much smaller set of authored interpretations. [Mateas & Stern, “Writing Façade: A Case Study in Procedural Authorship”](https://electronicbookreview.com/publications/writing-facade-a-case-study-in-procedural-authorship/)

For a hackathon slice, Boson should borrow Façade’s social focus rather than its runtime length: give the player a simple reason to join an ordinary village activity, let three residents respond differently to the same small issue, and end on a clear realization that came from their conversations. A 3–5 minute scene has room for one contradiction and one follow-up, not a mystery tree. The current coarse semantic vocabulary means the story must not depend on an LLM recognizing subtle open-ended positions like irony, accusation, or negotiation. Those would require explicit authored semantics and tests.

## What Boson already has

- Three authored residents with distinct goals: Anna protects seedlings and food, James protects reliable route records, and Thomas protects the bakery and his reputation. Their nine routine stops include the shared `market-well` stop plus the garden, map, bakery, river-gate, seed-shed, and grain-store areas. See [village-profiles.ts](../packages/minecraft/src/village-profiles.ts).
- The Quiet Bell fact set: silent bell, flour ledger, route mark, Anna’s private sighting, Thomas’s denial, and later contradiction. The answer is fixed in [village-mystery-design.md](village-mystery-design.md), while private disclosure is gated in [village-cognition.ts](../packages/minecraft/src/village-cognition.ts).
- Typed per-resident memory, authored action-plus-line beats, an in-range player-intent event, recent player-request recall, a recipient-owned ambient-claim reaction, and a trust threshold for Anna’s sighting. The kernel and tests prove these components with synthetic events.
- A vanilla plains village from seed `244`, with a datapack that sets world spawn on an open village path. The repository contains no bespoke story props, animated evidence, or custom village art. See [minecraft-world.md](minecraft-world.md) and `config/minecraft/world-packs/boson-village-spawn/`.

The mechanism proves bounded responses, memory and gates; it does not prove either complete story below. Routine stop names are semantic targets, not evidence that a physical map, ledger, bread basket, or meeting table has been built as an interactive prop. The current player intent set is `greet`, `ask_about_known_topic`, `ask_for_help`, `leave`, and `unknown`; it has no explicit accuse, share-evidence, bargain, take-sides, or resource-allocation act. See [village-vocabulary.js](../packages/minecraft/src/village-vocabulary.js).

## Option A — The Equal Loaf

**Premise:** The player is newly arrived and Thomas asks them to help carry a loaf to the village’s shared midday table. It is a small welcome, and all three residents are already nearby doing ordinary work. In conversation, the player discovers that “everyone gets a share” means every household on James’s map; Anna’s rotating garden workers are listed as labor, not as households. The player’s role is to notice and ask about the mismatch, not to investigate a crime or adjudicate a policy.

**Target length:** 3–5 minutes; one small social scene, roughly three encounters, one follow-up, one closing exchange.

**Staging note:** The shared table, loaf handoff, and all three residents being nearby are authored staging proposals. `market-well` is an existing semantic stop, but co-location and interactive props are unverified.

**Dramatic question:** Who counts as “everyone” when the village says its table is shared?

### Three encounters

1. **A simple welcome.** Thomas hands the newcomer a loaf to carry to the shared table and says he has set aside one for every household. This gives the player an immediate, ordinary task and a reason to speak with the others. His bakery route continues; no countdown or failure state is needed.
2. **Two versions of the same rule.** James points out the household marks on his village map and describes the distribution as even. Anna, encountered near her garden, says the people who tend the beds are expected to contribute vegetables but are not on the household list. She is not asking the player to fix it; she wants the work and workers to be acknowledged. The player can ask either person a follow-up, making the discovery through a second account rather than a hidden object.
3. **A small public recognition.** Thomas asks where the last loaf should go. If the player has heard Anna’s account, an authored response can let them mention the garden workers; Thomas pauses, recognizes that his “every household” claim left them out, and offers to set the loaf at the shared table for whoever worked the beds. James corrects the label on the map legend. Anna accepts the acknowledgment without implying that one loaf repairs the wider inequity. If the player did not hear both accounts, Thomas simply sets the loaf out and the scene closes with an invitation to stay.

**Satisfying realization:** The class divide is visible in a mundane definition, not announced in a speech: one resident’s map calls the distribution equal while another resident’s labor is excluded from the category being counted. The closing action is modest and immediate—who gets recognized and included at the table—while the larger village arrangement remains a question for future stories.

**Distinct resident wants and loyalties:** Thomas wants to be a generous host and protect the bakery’s standing; James wants his map to be a dependable public record and trusts its household categories; Anna wants the garden workers’ contribution treated as real work, but does not want to expose them to a public dispute without their consent. These motives overlap around the shared table but conflict over whether the current arrangement is fair. Keep these as proposed characterization for this story, not claims about existing story canon.

**Fit and missing pieces:** Existing routines, local dialogue, resident goals, topic questions, and recipient-local memory could support the encounters. However, the garden-worker exclusion, map category, loaf handoff, the residents’ specific wants, and the scene close are new authored story content. To make the optional inclusion ending dependable, the implementation needs a small scene flag recording whether the player heard both accounts and an explicit authored follow-up choice or topic trigger; the current intent set does not contain a general “raise the contradiction” or “include them” action. Avoid letting a model invent or infer the class issue from open-ended text.

## Option B — The Dry Path

**Premise:** James asks the newcomer to help check which route to the market is easiest to follow. He calls the raised stone path the village’s reliable route. Anna says the gardeners carrying baskets are directed along the lower muddy path; Thomas explains that his bakery deliveries use the raised one because it keeps the loaves dry. The player discovers that the “best route” depends on whose time and goods the map is designed to protect.

**Target length:** 3–5 minutes; a short walk or a stationary conversation with a visible route marker, if the map layout supports it.

**Staging note:** `map-board` is an existing semantic stop; a raised/lower path pairing and visible route marker are proposed details, not verified terrain or props.

### Three encounters

1. **The map task.** James asks the player to check one route mark. He wants a map that newcomers can trust and starts with the raised path as the default.
2. **The lived routes.** Anna explains the lower path is the one garden workers use with baskets, though it is longer and muddy. Thomas explains why he favors the raised path for bakery deliveries. Neither is a villain: each describes a real constraint from their work.
3. **A changed legend.** After hearing both accounts, the player can ask James to mark the lower path as a working route too. James adds a second route description instead of replacing the raised route. Anna is glad the map now reflects her workers’ route; Thomas keeps his dry-delivery route. If the player only checks James’s initial route, the map stays unchanged and he still thanks them for checking.

**Satisfying realization:** A neutral-sounding map standard encodes whose inconvenience counts. The player sees the missing perspective become legible through two short conversations and one small revision, rather than through an explicit lecture about class.

**Fit and missing pieces:** James’s cartographer role, the existing map stop, and resident-local conversation can anchor the scene. The class difference, route conditions, visible route marker, and map-edit ending are all proposals; no special marker or terrain was verified. A dependable revision needs a small authored follow-up state and a visible or spoken confirmation. This option is less resource-focused than Option A and makes the divide spatial: public infrastructure is described from the viewpoint of residents with different work and goods.

## Façade principles at this scale

- **Give the player a social role immediately:** carrying a loaf or checking a route is understandable without a tutorial or backstory.
- **Make ordinary talk carry the conflict:** the contradiction emerges from how residents describe routine village rules, not from a dramatic revelation or lore dump.
- **Let reactions matter locally:** the player’s follow-up determines which residents respond and whether a small acknowledgment or record change occurs. Keep the consequence observable in a line or action.
- **End on a legible beat:** close after the recognition or map correction. A 3–5 minute scene does not need a branching finale; it needs a clear change in what the player understands and one small consequence.
- **Keep authorship bounded:** use authored topics, lines, and conditions for the contradiction. Do not rely on broad natural-language negotiation or ask the model to decide what counts as evidence or fairness.

## Discussion direction

Option A is the clearest first slice: the shared loaf creates an immediate, human reason to care, and the exclusion becomes apparent through a simple mismatch between a public count and a worker’s account. Option B offers a distinct alternative if the team prefers spatial storytelling and a map-centered visible change. Both can reuse Boson’s short authored interaction pattern, but neither class-divide premise or ending is implemented or established story canon. Keep Quiet Bell as a separate existing proposal; do not import its murder facts, clue logic, or mystery pacing into either adaptation.

Both remain discussion drafts. The exact player follow-up, eligibility state, and closing action should be settled before implementation scope is estimated.

## Sources

- Mateas, M., & Stern, A. (2003). [“Façade: An Experiment in Interactive Drama”](https://www.cp.eng.chula.ac.th/~vishnu/gameResearch/story_november_2005/MateasSternGDC03.pdf). GDC 2003. Primary author paper.
- Mateas, M., & Stern, A. (2005). [“Structuring Content in the Façade Interactive Drama Architecture”](https://doi.org/10.1609/aiide.v1i1.18722). Proceedings of the First AIIDE Conference, 1(1), 93–98. Primary author paper.
- Mateas, M., & Stern, A. [“Writing Façade: A Case Study in Procedural Authorship”](https://electronicbookreview.com/publications/writing-facade-a-case-study-in-procedural-authorship/). Author case study.
