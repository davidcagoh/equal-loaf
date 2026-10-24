import { RESIDENT_DISPLAY_NAMES, villageProfiles } from './village-profiles.ts';
import { PLAYER_INTENTS, VILLAGE_TOPICS } from './village-vocabulary.js';

export { PLAYER_INTENTS, VILLAGE_TOPICS };
export type PlayerIntent = typeof PLAYER_INTENTS[number];
export type VillageTopic = typeof VILLAGE_TOPICS[number];
export type ResidentAction =
  | { kind: 'idle' }
  | { kind: 'look_at_player' }
  | { kind: 'continue_routine'; waypointId: string }
  | { kind: 'walk_to'; waypointId: string };
export type SpeechIntent =
  | { kind: 'authored_line'; lineId: string };

export interface HeardClaim {
  eventId: string;
  sourceId: string;
  topic: VillageTopic;
  intent?: PlayerIntent;
  claimedFactId?: string;
  tick: number;
}

export interface ResidentCognition {
  knownFactIds: readonly string[];
  heardClaims: readonly HeardClaim[];
  trust: number;
  completedBeatTicks: Readonly<Record<string, number>>;
  lastResponseTick: number | null;
}

export interface VillageCognitionState {
  processedEventIds: readonly string[];
  residents: Readonly<Record<string, ResidentCognition>>;
}

interface ObservationBase {
  eventId: string;
  /** Monotonic simulation time in milliseconds. */
  tick: number;
  recipientIds: readonly string[];
}

export type VillageObservation =
  | (ObservationBase & { type: 'player.intent'; intent: PlayerIntent; topic: VillageTopic; claimedFactId?: string })
  | (ObservationBase & { type: 'resident.utterance'; speakerId: string; topic: VillageTopic; claimedFactId?: string })
  | (ObservationBase & { type: 'resident.fact_disclosed'; speakerId: string; factId: string })
  | (ObservationBase & { type: 'world.fact_observed'; factId: string })
  | (ObservationBase & { type: 'player.behavior'; behavior: 'respectful_exchange' })
  | { type: 'beat.completed'; eventId: string; tick: number; residentId: string; beatId: string };

export interface ResidentIntentContext {
  residentId: string;
  playerIntent: PlayerIntent;
  topic: VillageTopic;
  locationId: string;
  tick: number;
  /** Optional identity of the in-range utterance that should ground this response. */
  heardClaimEventId?: string;
  /** Optional identity of the recent in-range player intent that should ground this response. */
  heardPlayerIntentEventId?: string;
}

export interface SelectedResidentIntent {
  eventType: 'resident.intent';
  residentId: string;
  beatId: string;
  action: ResidentAction;
  speech: SpeechIntent;
  selectedAtTick: number;
  expiresAtTick: number;
  allowedFactIds: readonly string[];
}

export interface ResidentKnowledgeContext {
  residentId: string;
  goal: string;
  factIds: readonly string[];
  topics: readonly VillageTopic[];
  responseOptions: readonly ResidentResponseOption[];
  relationship: 'unfamiliar' | 'cautious' | 'trusted';
}

export interface ResidentResponseOption {
  lineId: string;
  summary: string;
  allowedIntents: readonly PlayerIntent[];
  topics: readonly VillageTopic[];
}

export interface SemanticResponse {
  playerIntent: PlayerIntent;
  topic: VillageTopic;
  lineId: string;
}

export interface ResolvedPttResidentIntent {
  semanticResponse: SemanticResponse;
  context: ResidentIntentContext;
  intent: SelectedResidentIntent;
}

export const VILLAGE_FACTS = Object.freeze({
  'silent-bell': { topic: 'bell', text: 'Rowan’s usual dawn bell did not ring.' },
  'mira-sighting': { topic: 'garden', text: `${RESIDENT_DISPLAY_NAMES.mira} saw ${RESIDENT_DISPLAY_NAMES.pip} return by the garden path before dawn.` },
  'seedlings-safe': { topic: 'garden', text: `${RESIDENT_DISPLAY_NAMES.mira} moved the seedlings uphill, where they are safe.` },
  'flour-ledger': { topic: 'flour', text: 'The flour ledger is short by two sacks.' },
  'route-mark': { topic: 'route', text: `${RESIDENT_DISPLAY_NAMES.tobin}’s map marks a flour cart route by the bell-house path, but not its driver.` },
  'pip-denial': { topic: 'bakery', text: `${RESIDENT_DISPLAY_NAMES.pip} says he stayed in the bakery all night and the ovens were cold until morning.` },
  'pip-contradiction': { topic: 'bakery', text: `${RESIDENT_DISPLAY_NAMES.pip} later says he returned to the bakery after dawn and relit the hearth.` },
  'equal-loaf-thomas-claim': { topic: 'general', text: `${RESIDENT_DISPLAY_NAMES.pip} says he set aside one loaf for every household.` },
  'equal-loaf-household-count': { topic: 'route', text: `${RESIDENT_DISPLAY_NAMES.tobin} counts one share for each household on the village map.` },
  'equal-loaf-garden-workers': { topic: 'garden', text: `${RESIDENT_DISPLAY_NAMES.mira} says the garden workers are not on the household list.` },
} as const satisfies Record<string, { topic: VillageTopic; text: string }>);

type FactId = keyof typeof VILLAGE_FACTS;
const PUBLIC_OBSERVABLE_FACTS: readonly FactId[] = ['silent-bell', 'seedlings-safe', 'flour-ledger', 'route-mark'];
const HEARABLE_CLAIM_FACTS: readonly FactId[] = [
  ...PUBLIC_OBSERVABLE_FACTS,
  'equal-loaf-thomas-claim',
  'equal-loaf-household-count',
  'equal-loaf-garden-workers',
];
const SCENE_FACT_OWNERS = {
  'equal-loaf-thomas-claim': 'pip',
  'equal-loaf-household-count': 'tobin',
  'equal-loaf-garden-workers': 'mira',
} as const;

export function isPublicObservableFactId(value: string): value is FactId {
  return value in VILLAGE_FACTS && PUBLIC_OBSERVABLE_FACTS.includes(value as FactId);
}

interface AuthoredBeat {
  id: string;
  residentId: string;
  priority: number;
  requiredIntent: readonly PlayerIntent[];
  requiredTopics: readonly VillageTopic[];
  requiredLocation: string;
  requiredFactIds: readonly FactId[];
  requiredHeardClaim?: { sourceId: string; factId: FactId };
  requiredHeardPlayerIntent?: { intent: PlayerIntent; topic: VillageTopic };
  minimumTrust: number;
  cooldownTicks: number;
  expiresInTicks: number;
  modelSelectableLine: boolean;
  sceneOnly?: boolean;
  lineSummary: string;
  action: ResidentAction;
  lineId: string;
}

const RESPONSE_COOLDOWN_TICKS = 3_000;
const PLAYER_INTENT_MEMORY_WINDOW_MS = 120_000;
const AUTHORED_BEATS: readonly AuthoredBeat[] = [
  {
    id: 'mira-disclose-sighting', residentId: 'mira', priority: 100,
    requiredIntent: ['ask_about_known_topic', 'ask_for_help'], requiredTopics: ['garden'],
    requiredLocation: 'west-garden', requiredFactIds: ['mira-sighting'], minimumTrust: 2,
    cooldownTicks: 60_000, expiresInTicks: 5_000, modelSelectableLine: false,
    lineSummary: 'A private clue disclosure selected locally after its story prerequisites.',
    action: { kind: 'continue_routine', waypointId: 'west-garden' }, lineId: 'mira-sighting-disclosure',
  },
  {
    id: 'mira-guarded-garden-reply', residentId: 'mira', priority: 20,
    requiredIntent: ['greet', 'ask_about_known_topic', 'ask_for_help'], requiredTopics: ['general', 'garden'],
    requiredLocation: 'west-garden', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: 3_000, expiresInTicks: 5_000, modelSelectableLine: true,
    lineSummary: 'A cautious greeting that returns attention to the seedling work.',
    action: { kind: 'look_at_player' }, lineId: 'mira-guarded-garden-reply',
  },
  {
    id: 'mira-garden-help-reply', residentId: 'mira', priority: 20,
    requiredIntent: ['ask_for_help'], requiredTopics: ['garden'],
    requiredLocation: 'west-garden', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: 3_000, expiresInTicks: 5_000, modelSelectableLine: true,
    lineSummary: 'A guarded offer to help with a practical garden task.',
    action: { kind: 'continue_routine', waypointId: 'west-garden' }, lineId: 'mira-garden-help-reply',
  },
  {
    id: 'mira-heard-garden-help', residentId: 'mira', priority: 80,
    requiredIntent: ['greet'], requiredTopics: ['general'],
    requiredLocation: 'west-garden', requiredFactIds: [],
    requiredHeardPlayerIntent: { intent: 'ask_for_help', topic: 'garden' }, minimumTrust: 1,
    cooldownTicks: 60_000, expiresInTicks: 5_000, modelSelectableLine: false,
    lineSummary: 'A local follow-up to the player’s recent request for help with the seedlings.',
    action: { kind: 'idle' }, lineId: 'mira-heard-garden-help',
  },
  {
    id: 'mira-routine-greeting', residentId: 'mira', priority: 10,
    requiredIntent: ['greet'], requiredTopics: ['general'],
    requiredLocation: '*', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: RESPONSE_COOLDOWN_TICKS, expiresInTicks: 5_000, modelSelectableLine: true,
    lineSummary: 'A brief everyday greeting while Anna is making her rounds.',
    action: { kind: 'look_at_player' }, lineId: 'mira-routine-greeting',
  },
  {
    id: 'tobin-guarded-route-reply', residentId: 'tobin', priority: 20,
    requiredIntent: ['greet', 'ask_about_known_topic', 'ask_for_help'], requiredTopics: ['general', 'route'],
    requiredLocation: 'map-board', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: 3_000, expiresInTicks: 5_000, modelSelectableLine: true,
    lineSummary: 'A precise response focused on the map and uncertainty about the driver.',
    action: { kind: 'continue_routine', waypointId: 'map-board' }, lineId: 'tobin-guarded-route-reply',
  },
  {
    id: 'tobin-routine-greeting', residentId: 'tobin', priority: 10,
    requiredIntent: ['greet'], requiredTopics: ['general'],
    requiredLocation: '*', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: RESPONSE_COOLDOWN_TICKS, expiresInTicks: 5_000, modelSelectableLine: true,
    lineSummary: 'A brief everyday greeting while James is checking the village paths.',
    action: { kind: 'look_at_player' }, lineId: 'tobin-routine-greeting',
  },
  {
    id: 'pip-guarded-bakery-reply', residentId: 'pip', priority: 20,
    requiredIntent: ['greet', 'ask_about_known_topic', 'ask_for_help'], requiredTopics: ['general', 'bakery'],
    requiredLocation: 'bakery-hearth', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: 3_000, expiresInTicks: 5_000, modelSelectableLine: true,
    lineSummary: 'A warm, brief response focused on bakery work.',
    action: { kind: 'continue_routine', waypointId: 'bakery-hearth' }, lineId: 'pip-guarded-bakery-reply',
  },
  {
    id: 'pip-routine-greeting', residentId: 'pip', priority: 10,
    requiredIntent: ['greet'], requiredTopics: ['general'],
    requiredLocation: '*', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: RESPONSE_COOLDOWN_TICKS, expiresInTicks: 5_000, modelSelectableLine: true,
    lineSummary: 'A brief everyday greeting while Thomas walks between the bakery and market.',
    action: { kind: 'look_at_player' }, lineId: 'pip-routine-greeting',
  },
  {
    id: 'equal-loaf-thomas-welcome', residentId: 'pip', priority: 30,
    requiredIntent: ['greet'], requiredTopics: ['general'], requiredLocation: '*', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: RESPONSE_COOLDOWN_TICKS, expiresInTicks: 5_000, modelSelectableLine: true, sceneOnly: true,
    lineSummary: 'A friendly welcome and Thomas’s account of how he set aside bread for the village.',
    action: { kind: 'look_at_player' }, lineId: 'equal-loaf.thomas.welcome',
  },
  {
    id: 'equal-loaf-james-household-map', residentId: 'tobin', priority: 30,
    requiredIntent: ['ask_about_known_topic'], requiredTopics: ['route'], requiredLocation: '*', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: RESPONSE_COOLDOWN_TICKS, expiresInTicks: 5_000, modelSelectableLine: true, sceneOnly: true,
    lineSummary: 'James explains that the map count uses households as its unit.',
    action: { kind: 'look_at_player' }, lineId: 'equal-loaf.james.household-map',
  },
  {
    id: 'equal-loaf-anna-garden-workers', residentId: 'mira', priority: 30,
    requiredIntent: ['ask_about_known_topic'], requiredTopics: ['garden'], requiredLocation: '*', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: RESPONSE_COOLDOWN_TICKS, expiresInTicks: 5_000, modelSelectableLine: true, sceneOnly: true,
    lineSummary: 'Anna describes the garden workers’ contribution and their request for privacy.',
    action: { kind: 'look_at_player' }, lineId: 'equal-loaf.anna.garden-workers',
  },
  {
    id: 'equal-loaf-thomas-close', residentId: 'pip', priority: 30,
    requiredIntent: ['ask_for_help'], requiredTopics: ['bakery'], requiredLocation: '*', requiredFactIds: [], minimumTrust: 0,
    cooldownTicks: RESPONSE_COOLDOWN_TICKS, expiresInTicks: 5_000, modelSelectableLine: true, sceneOnly: true,
    lineSummary: 'Thomas closes the bread conversation with an ordinary invitation to share the table.',
    action: { kind: 'look_at_player' }, lineId: 'equal-loaf.thomas.ordinary-close',
  },
  {
    id: 'pip-heard-route-from-tobin', residentId: 'pip', priority: 30,
    requiredIntent: ['greet'], requiredTopics: ['general'],
    requiredLocation: 'bakery-hearth', requiredFactIds: [], requiredHeardClaim: { sourceId: 'tobin', factId: 'route-mark' }, minimumTrust: 0,
    cooldownTicks: 3_000, expiresInTicks: 5_000, modelSelectableLine: true,
    lineSummary: 'A reply that attributes a route claim to a neighbor without treating it as verified.',
    action: { kind: 'look_at_player' }, lineId: 'pip-heard-route-from-tobin',
  },
];

const AUTHORED_LINES = Object.freeze({
  'mira-sighting-disclosure': `I saw ${RESIDENT_DISPLAY_NAMES.pip} come back along the garden path before dawn. I was afraid to say so.`,
  'mira-guarded-garden-reply': 'The seedlings are safer uphill. I have work to finish before we talk more.',
  'mira-garden-help-reply': 'I could use help checking the seedlings. Stay on the garden path, please.',
  'mira-heard-garden-help': 'You asked about helping in the garden earlier. I could use another pair of hands checking the seedlings.',
  'mira-routine-greeting': 'Hello. I’m checking the garden and seed beds as I make my rounds.',
  'tobin-guarded-route-reply': 'The map shows the route. It does not tell me who drove the cart.',
  'tobin-routine-greeting': 'Hello. I’m checking the paths and updating my village map.',
  'pip-guarded-bakery-reply': 'The oven needs watching. There is warm bread when the work is done.',
  'pip-routine-greeting': 'Hello. I’m on my way between the bakery and the village market.',
  'pip-heard-route-from-tobin': 'Tobin marked a flour cart path on his map. I heard him say it, but I have not checked that route myself.',
} as const);

function clampTrust(value: number): number {
  return Math.max(-2, Math.min(2, value));
}

function relationshipBand(trust: number): ResidentKnowledgeContext['relationship'] {
  if (trust >= 2) return 'trusted';
  return trust < 0 ? 'cautious' : 'unfamiliar';
}

export function createVillageCognitionState(): VillageCognitionState {
  return {
    processedEventIds: [],
    residents: Object.fromEntries(villageProfiles.map((profile) => [profile.id, {
      knownFactIds: [...profile.knownFactIds], heardClaims: [], trust: 0, completedBeatTicks: {}, lastResponseTick: null,
    }])),
  };
}

/** Returns a claim event recorded by this resident, so callers cannot ground a response in a bystander's hearing. */
export function latestHeardClaimEventId(
  state: VillageCognitionState,
  residentId: string,
  sourceId: string,
  claimedFactId: string,
): string | undefined {
  const claims = state.residents[residentId]?.heardClaims ?? [];
  return [...claims].reverse().find((claim) => claim.sourceId === sourceId && claim.claimedFactId === claimedFactId)?.eventId;
}

/** Returns a recent player-intent event stored in this resident’s own memory. */
export function latestHeardPlayerIntentEventId(
  state: VillageCognitionState,
  residentId: string,
  intent: PlayerIntent,
  topic: VillageTopic,
  now: number,
): string | undefined {
  const claims = state.residents[residentId]?.heardClaims ?? [];
  return claims
    .filter((claim) => claim.sourceId === 'player' && claim.intent === intent && claim.topic === topic &&
      now >= claim.tick && now - claim.tick <= PLAYER_INTENT_MEMORY_WINDOW_MS)
    .sort((left, right) => right.tick - left.tick)[0]?.eventId;
}

export function reduceVillageObservation(state: VillageCognitionState, observation: VillageObservation): VillageCognitionState {
  if (state.processedEventIds.includes(observation.eventId)) return state;
  const processedEventIds = [...state.processedEventIds, observation.eventId];
  if (processedEventIds.length > 512) processedEventIds.shift();
  const residents = { ...state.residents };

  if (observation.type === 'beat.completed') {
    const resident = residents[observation.residentId];
    if (!resident) return { ...state, processedEventIds };
    residents[observation.residentId] = {
      ...resident,
      completedBeatTicks: { ...resident.completedBeatTicks, [observation.beatId]: observation.tick },
      lastResponseTick: observation.tick,
    };
    return { processedEventIds, residents };
  }

  if (observation.type === 'resident.fact_disclosed') {
    const owner = SCENE_FACT_OWNERS[observation.factId as keyof typeof SCENE_FACT_OWNERS];
    if (owner !== observation.speakerId || !(observation.factId in VILLAGE_FACTS)) return { processedEventIds, residents };
    for (const residentId of observation.recipientIds) {
      const resident = residents[residentId];
      if (resident && residentId === owner) {
        residents[residentId] = { ...resident, knownFactIds: [...new Set([...resident.knownFactIds, observation.factId])] };
      }
    }
    return { processedEventIds, residents };
  }

  for (const residentId of observation.recipientIds) {
    const resident = residents[residentId];
    if (!resident) continue;
    if (observation.type === 'world.fact_observed') {
      if (!(observation.factId in VILLAGE_FACTS) || !PUBLIC_OBSERVABLE_FACTS.includes(observation.factId as FactId)) continue;
      residents[residentId] = { ...resident, knownFactIds: [...new Set([...resident.knownFactIds, observation.factId])] };
      continue;
    }
    if (observation.type === 'player.behavior') {
      residents[residentId] = { ...resident, trust: clampTrust(resident.trust + 1) };
      continue;
    }
    if (observation.type === 'resident.utterance' && observation.claimedFactId !== undefined) {
      const speaker = state.residents[observation.speakerId];
      const fact = VILLAGE_FACTS[observation.claimedFactId as FactId];
      if (!speaker || !HEARABLE_CLAIM_FACTS.includes(observation.claimedFactId as FactId) ||
        !speaker.knownFactIds.includes(observation.claimedFactId) || !fact || fact.topic !== observation.topic) continue;
    }
    const claim: HeardClaim = {
      eventId: observation.eventId,
      sourceId: observation.type === 'player.intent' ? 'player' : observation.speakerId,
      topic: observation.topic,
      ...(observation.type === 'player.intent' ? { intent: observation.intent } : {}),
      ...(observation.claimedFactId && observation.claimedFactId in VILLAGE_FACTS ? { claimedFactId: observation.claimedFactId } : {}),
      tick: observation.tick,
    };
    residents[residentId] = { ...resident, heardClaims: [...resident.heardClaims, claim].slice(-64) };
  }

  return { processedEventIds, residents };
}

export function getResidentKnowledgeContext(
  state: VillageCognitionState,
  residentId: string,
  scene?: ResidentIntentContext,
): ResidentKnowledgeContext & { facts: readonly string[] } {
  const profile = villageProfiles.find(({ id }) => id === residentId);
  const resident = state.residents[residentId];
  if (!profile || !resident) throw new TypeError(`Unknown village resident: ${residentId}`);
  const factIds = resident.knownFactIds.filter((factId): factId is FactId =>
    factId in VILLAGE_FACTS && isFactDisclosable(factId, state, resident, scene));
  const topics = [...new Set(factIds.map((factId) => VILLAGE_FACTS[factId].topic))];
  const responseOptions = AUTHORED_BEATS
    .filter((beat) => beat.residentId === residentId && beat.modelSelectableLine && beat.requiredFactIds.every((factId) => factIds.includes(factId)) &&
      (!beat.requiredHeardClaim || hasHeardClaim(resident, beat.requiredHeardClaim, scene?.heardClaimEventId)) &&
      (!beat.requiredHeardPlayerIntent || hasHeardPlayerIntent(resident, beat.requiredHeardPlayerIntent, scene)) &&
      (!scene || beat.requiredLocation === '*' || scene.locationId === beat.requiredLocation))
    .map(({ lineId, lineSummary, requiredIntent, requiredTopics }) => ({
      lineId, summary: lineSummary, allowedIntents: requiredIntent, topics: requiredTopics,
    }));
  return {
    residentId,
    goal: profile.goal,
    factIds,
    facts: factIds.map((factId) => VILLAGE_FACTS[factId].text),
    topics,
    responseOptions,
    relationship: relationshipBand(resident.trust),
  };
}

function hasHeardClaim(
  resident: ResidentCognition,
  required: NonNullable<AuthoredBeat['requiredHeardClaim']>,
  eventId?: string,
): boolean {
  return resident.heardClaims.some((claim) => claim.sourceId === required.sourceId && claim.claimedFactId === required.factId &&
    (eventId === undefined || claim.eventId === eventId));
}

function hasHeardPlayerIntent(
  resident: ResidentCognition,
  required: NonNullable<AuthoredBeat['requiredHeardPlayerIntent']>,
  context?: ResidentIntentContext,
): boolean {
  const now = context?.tick ?? Date.now();
  return resident.heardClaims.some((claim) => claim.sourceId === 'player' && claim.intent === required.intent &&
    claim.topic === required.topic && now >= claim.tick && now - claim.tick <= PLAYER_INTENT_MEMORY_WINDOW_MS &&
    (context?.heardPlayerIntentEventId === undefined || claim.eventId === context.heardPlayerIntentEventId));
}

function isFactDisclosable(
  factId: FactId,
  state: VillageCognitionState,
  resident: ResidentCognition,
  context: ResidentIntentContext | undefined,
): boolean {
  if (factId === 'mira-sighting') {
    return resident.trust >= 2 && context?.residentId === 'mira' && context.locationId === 'west-garden' &&
      (context.playerIntent === 'ask_about_known_topic' || context.playerIntent === 'ask_for_help') && context.topic === 'garden';
  }
  if (factId === 'pip-contradiction') {
    return state.residents.mira?.completedBeatTicks['mira-disclose-sighting'] !== undefined &&
      context?.residentId === 'pip' && context.locationId === 'bakery-hearth' && context.topic === 'bakery';
  }
  return true;
}

function isValidPlayerIntent(value: unknown): value is PlayerIntent {
  return typeof value === 'string' && (PLAYER_INTENTS as readonly string[]).includes(value);
}

function isValidTopic(value: unknown): value is VillageTopic {
  return typeof value === 'string' && (VILLAGE_TOPICS as readonly string[]).includes(value);
}

function isIntentTopicEligible(intent: PlayerIntent, topic: VillageTopic, context: ResidentKnowledgeContext): boolean {
  if (intent === 'ask_about_known_topic') return context.topics.includes(topic);
  if (intent === 'ask_for_help') return topic === 'general' || context.topics.includes(topic);
  return topic === 'general' || context.topics.includes(topic);
}

export function validateSemanticResponse(
  value: unknown,
  options: { residentId: string; context: ResidentKnowledgeContext },
): SemanticResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'lineId,playerIntent,topic') return null;
  if (options.context.residentId !== options.residentId) return null;
  if (!isValidPlayerIntent(candidate.playerIntent) || !isValidTopic(candidate.topic) || typeof candidate.lineId !== 'string') return null;
  if (candidate.playerIntent === 'leave' || candidate.topic === 'bell' && !options.context.topics.includes('bell')) return null;
  if (!isIntentTopicEligible(candidate.playerIntent, candidate.topic, options.context)) return null;
  const option = options.context.responseOptions.find(({ lineId }) => lineId === candidate.lineId);
  if (!option || !option.allowedIntents.includes(candidate.playerIntent) || !option.topics.includes(candidate.topic)) return null;
  const responseBeat = AUTHORED_BEATS.find((beat) => beat.residentId === options.residentId && beat.lineId === candidate.lineId && beat.modelSelectableLine);
  if (!responseBeat) return null;
  return { playerIntent: candidate.playerIntent, topic: candidate.topic, lineId: candidate.lineId };
}

/** Validate only public model choices, then derive the actual local story intent independently. */
export function resolvePttResidentIntent(
  state: VillageCognitionState,
  scene: Omit<ResidentIntentContext, 'playerIntent' | 'topic'>,
  seed: number,
  value: unknown,
): ResolvedPttResidentIntent | null {
  const semanticResponse = validateSemanticResponse(value, {
    residentId: scene.residentId,
    context: getResidentKnowledgeContext(state, scene.residentId),
  });
  if (!semanticResponse) return null;
  const context: ResidentIntentContext = {
    ...scene,
    playerIntent: semanticResponse.playerIntent,
    topic: semanticResponse.topic,
  };
  const intent = selectResidentIntent(state, context, seed, semanticResponse);
  if (!intent || !validateResidentIntent(state, intent, context)) return null;
  return { semanticResponse, context, intent };
}

function eligibleBeats(state: VillageCognitionState, context: ResidentIntentContext, includeSceneOnly = false): readonly AuthoredBeat[] {
  const resident = state.residents[context.residentId];
  if (!resident || (resident.lastResponseTick !== null && context.tick - resident.lastResponseTick < RESPONSE_COOLDOWN_TICKS)) return [];
  return AUTHORED_BEATS.filter((beat) => {
    const lastCompleted = resident.completedBeatTicks[beat.id];
    return beat.residentId === context.residentId &&
      (includeSceneOnly || !beat.sceneOnly) &&
      beat.requiredIntent.includes(context.playerIntent) && beat.requiredTopics.includes(context.topic) &&
      (beat.requiredLocation === '*' || beat.requiredLocation === context.locationId) && beat.minimumTrust <= resident.trust &&
      beat.requiredFactIds.every((factId) => resident.knownFactIds.includes(factId)) &&
      (!beat.requiredHeardClaim || hasHeardClaim(resident, beat.requiredHeardClaim, context.heardClaimEventId)) &&
      (!beat.requiredHeardPlayerIntent || hasHeardPlayerIntent(resident, beat.requiredHeardPlayerIntent, context)) &&
      (lastCompleted === undefined || context.tick - lastCompleted >= beat.cooldownTicks);
  });
}

export function selectResidentIntent(
  state: VillageCognitionState,
  context: ResidentIntentContext,
  seed: number,
  semanticResponse?: SemanticResponse,
): SelectedResidentIntent | null {
  const resident = state.residents[context.residentId];
  if (!resident || !PLAYER_INTENTS.includes(context.playerIntent) || !VILLAGE_TOPICS.includes(context.topic)) return null;
  const includeSceneOnly = semanticResponse?.lineId.startsWith('equal-loaf.') === true;
  const candidates = eligibleBeats(state, context, includeSceneOnly).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  if (candidates.length === 0) return null;
  const fallbackBeat = candidates.reduce((selected, candidate) => {
    if (!selected || candidate.priority > selected.priority) return candidate;
    if (candidate.priority < selected.priority) return selected;
    return stableSeed(seed, candidate.id) < stableSeed(seed, selected.id) ? candidate : selected;
  }, undefined as AuthoredBeat | undefined);
  const validatedResponse = semanticResponse && semanticResponse.playerIntent === context.playerIntent && semanticResponse.topic === context.topic
    ? validateSemanticResponse(semanticResponse, {
      residentId: context.residentId,
      context: getResidentKnowledgeContext(state, context.residentId, context),
    })
    : null;
  const selectedBeat = validatedResponse && fallbackBeat?.modelSelectableLine
    ? candidates.find((candidate) => candidate.lineId === validatedResponse.lineId) ?? fallbackBeat
    : fallbackBeat;
  if (!selectedBeat) return null;
  return {
    eventType: 'resident.intent',
    residentId: selectedBeat.residentId,
    beatId: selectedBeat.id,
    action: selectedBeat.action,
    speech: { kind: 'authored_line', lineId: selectedBeat.lineId },
    selectedAtTick: context.tick,
    expiresAtTick: context.tick + selectedBeat.expiresInTicks,
    allowedFactIds: [...getResidentKnowledgeContext(state, context.residentId, context).factIds],
  };
}

export function validateResidentIntent(state: VillageCognitionState, intent: SelectedResidentIntent, context: ResidentIntentContext): boolean {
  if (intent.eventType !== 'resident.intent' || intent.residentId !== context.residentId || context.tick > intent.expiresAtTick) return false;
  const resident = state.residents[intent.residentId];
  if (!resident) return false;
  const allowedFactIds = getResidentKnowledgeContext(state, intent.residentId, { ...context, tick: intent.selectedAtTick }).factIds;
  if (intent.allowedFactIds.length !== allowedFactIds.length || intent.allowedFactIds.some((factId, index) => factId !== allowedFactIds[index])) return false;
  const beat = AUTHORED_BEATS.find(({ id, residentId }) => id === intent.beatId && residentId === intent.residentId);
  if (!beat || intent.expiresAtTick !== intent.selectedAtTick + beat.expiresInTicks || context.tick < intent.selectedAtTick) return false;
  if (!eligibleBeats(state, { ...context, tick: intent.selectedAtTick }, Boolean(beat.sceneOnly)).some(({ id }) => id === beat.id)) return false;
  if (intent.action.kind !== beat.action.kind || ('waypointId' in beat.action && intent.action.waypointId !== beat.action.waypointId)) return false;
  return intent.speech.kind === 'authored_line' && intent.speech.lineId === beat.lineId;
}

function stableSeed(seed: number, value: string): number {
  let hash = seed >>> 0;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return hash;
}

export function authoredLine(lineId: string): string | null {
  return lineId in AUTHORED_LINES ? AUTHORED_LINES[lineId as keyof typeof AUTHORED_LINES] : null;
}
