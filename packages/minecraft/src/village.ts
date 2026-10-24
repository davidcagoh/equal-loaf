import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { createInterface } from 'node:readline';
import {
  authoredLine,
  createVillageCognitionState,
  getResidentKnowledgeContext,
  latestHeardClaimEventId,
  latestHeardPlayerIntentEventId,
  isPublicObservableFactId,
  resolvePttResidentIntent,
  reduceVillageObservation,
  selectResidentIntent,
  validateResidentIntent,
  type ResidentIntentContext,
  type SelectedResidentIntent,
  type VillageObservation,
} from './village-cognition.ts';
import {
  asSemanticResponse,
  createVillageDialogueEvent,
  isVillagePttCommand,
  MAX_PTT_COMMAND_BYTES,
  type VillagePttAck,
  type VillagePttBeginContext,
  type VillagePttCommand,
  type VillageDialogueEvent,
} from './village-event.ts';
import { RESIDENT_DISPLAY_NAMES, villageDialogue, villageMysteryDialogue, villageProfiles } from './village-profiles.ts';
import { createAmbientUtteranceObservation, nextResidentDialogueTurn, type ResidentDialogueCursor } from './village-dialogue-scheduler.ts';
import { createRoutineWorldObservation } from './village-observations.ts';
import { distance3d, isWithinExplorerWatchRange, shouldPauseForExplorer, VillageAi } from './village-ai.ts';
import {
  createNoResidentGuidance,
  getCurrentRoutineStopId,
  getResidentsWithinHearingRadius,
  getRoutineStopPosition,
  selectPttResident,
  type EncounterResident,
} from './village-encounters.ts';
import { createEqualLoafState } from './village-short-scene.ts';
import { completeEqualLoafPttTurn } from './village-ptt-scene-integration.ts';
import { projectCompletedResidentSpeech, type NativeSpeechPositionSample } from './village-spoken-perception.ts';
import { projectCompletedPlayerSpeech, type NativePlayerSpeechPositionSample } from './village-player-speech-perception.ts';
import { VillageHeardSpeechMemory } from './village-heard-speech-memory.ts';
import { equalLoafResidentFact } from './native-resident-context.ts';

// Optional explicit env file keeps credentials in the local launcher process only.
if (process.env.BOSON_AI_ENV_FILE) process.loadEnvFile(process.env.BOSON_AI_ENV_FILE);

const { goals, Movements, pathfinder } = pathfinderPackage;

const host = process.env.BOSON_MC_HOST ?? '127.0.0.1';
const port = Number(process.env.BOSON_MC_PORT ?? 25565);
if (!new Set(['127.0.0.1', 'localhost', '::1']).has(host)) throw new TypeError('Village actors only connect to a loopback server');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('BOSON_MC_PORT must be a valid TCP port');

let stopping = false;
const bots = new Map(villageProfiles.map((profile) => {
  const bot = mineflayer.createBot({ host, port, username: profile.username, version: '1.21.11', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  return [profile.id, bot] as const;
}));
const spawned = new Set<string>();
const homePositions = new Map<string, { x: number; y: number; z: number }>();
const lastWatchTurnAt = new Map<string, number>();
const awarenessTimers: ReturnType<typeof setInterval>[] = [];
interface ActivePttTurn {
  turnId: string;
  residentId: string;
  residentSessionId?: string;
  startedAt: number;
  expiresAt: number;
  beginAck: VillagePttAck;
  playerSpeechSamples?: NativePlayerSpeechPositionSample[];
  playerSpeechTimer?: ReturnType<typeof setInterval>;
  playerSpeechSamplingComplete?: boolean;
  playerSpeechItems?: Array<{ itemId: string; transcript: string }>;
  playerSpeechItemIds?: Set<string>;
}
interface ActiveNativeSpeech {
  turnId: string;
  residentId: string;
  residentSessionId: string;
  responseId: string;
  itemId: string;
  samples: NativeSpeechPositionSample[];
  timer: ReturnType<typeof setInterval>;
  samplingComplete: boolean;
}
const activePttTurns = new Map<string, ActivePttTurn>();
const resolvedPttTurns = new Map<string, 'cancelled' | 'completed' | 'expired'>();
const activeNativeSpeech = new Map<string, ActiveNativeSpeech>();
const consumedNativeSpeechResponseIds = new Map<string, Set<string>>();
const consumedPlayerSpeechItemIds = new Map<string, Set<string>>();
const heardSpeechMemory = new VillageHeardSpeechMemory(3, 180_000);
const heardSpeechMemoryPruner = setInterval(() => heardSpeechMemory.prune(), 1_000);
heardSpeechMemoryPruner.unref();
const cognitionState = { current: createVillageCognitionState() };
let equalLoafSceneState = createEqualLoafState();
const RESIDENT_HEARING_RADIUS = 12;
const PTT_TURN_TTL_MS = 30_000;
const NATIVE_PTT_TURN_TTL_MS = 120_000;
const MAX_ACTIVE_PTT_TURNS = 8;
const MAX_ACTIVE_NATIVE_SPEECH = 8;
const MAX_NATIVE_SPEECH_SAMPLES = 500;
const MAX_PLAYER_SPEECH_ITEMS_PER_TURN = 8;
const NATIVE_SPEECH_SAMPLE_INTERVAL_MS = 250;
const ai = new VillageAi({ enabled: process.env.BOSON_VILLAGE_AI === '1', jevKey: process.env.TYPESAFE_API_KEY, gatewayKey: process.env.AI_GATEWAY_API_KEY });
const plannedLineIds = new Map<string, string>();
let dialogueSequence = 0;
let routineObservationSequence = 0;
const explorerName = process.env.BOSON_MC_PLAYER ?? 'DemoPlayer';

function explorerFor(bot: NonNullable<ReturnType<typeof bots.get>>) {
  return bot.players[explorerName]?.entity;
}
async function watchExplorer(bot: NonNullable<ReturnType<typeof bots.get>>): Promise<number | null> {
  const explorer = explorerFor(bot);
  if (!explorer || !bot.entity) return null;
  const distance = distance3d(bot.entity.position, explorer.position);
  if (shouldPauseForExplorer(distance)) bot.pathfinder.setGoal(null);
  const previous = lastWatchTurnAt.get(bot.username) ?? 0;
  if (isWithinExplorerWatchRange(distance) && Date.now() - previous >= 2_000) {
    lastWatchTurnAt.set(bot.username, Date.now());
    await bot.lookAt(explorer.position.offset(0, 1.5, 0), true).catch(() => undefined);
  }
  return distance;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentExplorerPosition(): { x: number; y: number; z: number } | null {
  for (const bot of bots.values()) {
    const explorer = explorerFor(bot);
    if (explorer) return { x: explorer.position.x, y: explorer.position.y, z: explorer.position.z };
  }
  return null;
}

function residentDistances(explorer: { x: number; y: number; z: number }): Array<{ residentId: string; distance: number }> {
  return villageProfiles.flatMap(({ id }) => {
    const bot = bots.get(id);
    return bot?.entity ? [{ residentId: id, distance: distance3d(bot.entity.position, explorer) }] : [];
  }).sort((left, right) => left.distance - right.distance || left.residentId.localeCompare(right.residentId));
}

function currentRoutineStop(residentId: string): string {
  const bot = bots.get(residentId);
  const home = homePositions.get(residentId);
  const profile = villageProfiles.find(({ id }) => id === residentId);
  if (!bot?.entity || !home || !profile) return profile?.routine[0]?.id ?? 'market-well';
  return getCurrentRoutineStopId(home, profile.routine, bot.entity.position) ?? profile.routine[0]?.id ?? 'market-well';
}

function currentEncounterResidents(): EncounterResident[] {
  return villageProfiles.flatMap(({ id, username }) => {
    const bot = bots.get(id);
    return bot?.entity ? [{
      residentId: id,
      name: username,
      position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      locationId: currentRoutineStop(id),
    }] : [];
  });
}

function recentHeardSpeech(residentId: string, now = Date.now()): VillagePttBeginContext['recentHeardSpeech'] {
  return heardSpeechMemory.recent(residentId, now);
}

function freshPttBeginContext(residentId: string, locationId: string): VillagePttBeginContext | null {
  const profile = villageProfiles.find(({ id }) => id === residentId);
  const state = cognitionState.current;
  if (!profile || !state.residents[residentId]) return null;
  const knowledge = getResidentKnowledgeContext(state, residentId, {
    residentId, playerIntent: 'greet', topic: 'general', locationId, tick: Date.now(),
  });
  const sceneFact = equalLoafResidentFact(residentId);
  return {
    id: profile.id,
    name: profile.username,
    role: profile.role,
    goal: knowledge.goal,
    locationId,
    topics: knowledge.topics,
    facts: sceneFact ? [...knowledge.facts, sceneFact] : knowledge.facts,
    responseOptions: knowledge.responseOptions,
    relationship: knowledge.relationship,
    recentHeardSpeech: recentHeardSpeech(residentId),
  };
}

function sendPttAck(ack: VillagePttAck): void {
  process.stdout.write(`${JSON.stringify(ack)}\n`);
}

function sendNativeAck(
  type: string,
  turnId: string,
  status: string,
  correlation?: { responseId?: string; itemId?: string; recipientCount?: number },
): void {
  process.stdout.write(`${JSON.stringify({
    version: 1, type, turnId, status,
    ...(correlation?.responseId ? { responseId: correlation.responseId } : {}),
    ...(correlation?.itemId ? { itemId: correlation.itemId } : {}),
    ...(correlation?.recipientCount === undefined ? {} : { recipientCount: correlation.recipientCount }),
  })}\n`);
}

function nativeSpeechKey(turnId: string, responseId: string, itemId: string): string {
  return `${turnId}:${responseId}:${itemId}`;
}

function sampleNativeSpeech(speech: ActiveNativeSpeech): NativeSpeechPositionSample | null {
  const speaker = bots.get(speech.residentId)?.entity?.position;
  if (!speaker) return null;
  const residents = currentEncounterResidents();
  process.stdout.write(`${JSON.stringify({
    type: 'village.residents', timestamp: Date.now(),
    residents: residents.map(({ residentId, name, position }) => ({ residentId, name, position })),
  })}\n`);
  return {
    tick: Date.now(),
    speakerPosition: { x: speaker.x, y: speaker.y, z: speaker.z },
    residents: residents.map(({ residentId, position }) => ({ residentId, position })),
  };
}

function samplePlayerSpeechPosition(): NativePlayerSpeechPositionSample | null {
  const player = currentExplorerPosition();
  if (!player) return null;
  const residents = currentEncounterResidents();
  process.stdout.write(`${JSON.stringify({
    type: 'village.residents', timestamp: Date.now(),
    residents: residents.map(({ residentId, name, position }) => ({ residentId, name, position })),
  })}\n`);
  return {
    tick: Date.now(),
    speakerPosition: player,
    residents: residents.map(({ residentId, position }) => ({ residentId, position })),
  };
}

function startPlayerSpeechSampling(turn: ActivePttTurn): void {
  const first = samplePlayerSpeechPosition();
  if (!first) {
    turn.playerSpeechSamplingComplete = false;
    return;
  }
  turn.playerSpeechSamples = [first];
  turn.playerSpeechSamplingComplete = true;
  turn.playerSpeechTimer = setInterval(() => {
    const sample = samplePlayerSpeechPosition();
    if (!sample || (turn.playerSpeechSamples?.length ?? 0) >= MAX_NATIVE_SPEECH_SAMPLES) {
      turn.playerSpeechSamplingComplete = false;
      if (turn.playerSpeechTimer) clearInterval(turn.playerSpeechTimer);
      return;
    }
    turn.playerSpeechSamples = [...(turn.playerSpeechSamples ?? []), sample];
  }, NATIVE_SPEECH_SAMPLE_INTERVAL_MS);
}

function stopPlayerSpeechSampling(turn: ActivePttTurn, takeFinalSample: boolean): void {
  if (turn.playerSpeechTimer) clearInterval(turn.playerSpeechTimer);
  turn.playerSpeechTimer = undefined;
  if (!takeFinalSample || !turn.playerSpeechSamplingComplete) return;
  const last = samplePlayerSpeechPosition();
  if (!last || (turn.playerSpeechSamples?.length ?? 0) >= MAX_NATIVE_SPEECH_SAMPLES) {
    turn.playerSpeechSamplingComplete = false;
    return;
  }
  turn.playerSpeechSamples = [...(turn.playerSpeechSamples ?? []), last];
}

function stopNativeSpeechForTurn(turnId: string): void {
  for (const [key, speech] of activeNativeSpeech) {
    if (speech.turnId !== turnId) continue;
    clearInterval(speech.timer);
    activeNativeSpeech.delete(key);
  }
}

function bindResidentSession(command: Extract<VillagePttCommand, { type: 'ptt.session.bind' }>): void {
  prunePttTurns();
  const turn = activePttTurns.get(command.turnId);
  if (!turn) {
    sendNativeAck('ptt.session.ack', command.turnId, 'expired');
    return;
  }
  if (turn.residentSessionId) {
    sendNativeAck('ptt.session.ack', command.turnId, turn.residentSessionId === command.residentSessionId ? 'bound' : 'mismatch');
    return;
  }
  turn.residentSessionId = command.residentSessionId;
  turn.expiresAt = Math.min(turn.startedAt + NATIVE_PTT_TURN_TTL_MS, Date.now() + NATIVE_PTT_TURN_TTL_MS);
  sendNativeAck('ptt.session.ack', command.turnId, 'bound');
}

function startNativeSpeech(command: Extract<VillagePttCommand, { type: 'ptt.speech.start' }>): void {
  prunePttTurns();
  const turn = activePttTurns.get(command.turnId);
  if (!turn || turn.residentSessionId !== command.residentSessionId) {
    sendNativeAck('ptt.speech.ack', command.turnId, 'no_session', { responseId: command.responseId, itemId: command.itemId });
    return;
  }
  const key = nativeSpeechKey(command.turnId, command.responseId, command.itemId);
  if (activeNativeSpeech.has(key)) {
    sendNativeAck('ptt.speech.ack', command.turnId, 'duplicate', { responseId: command.responseId, itemId: command.itemId });
    return;
  }
  if (activeNativeSpeech.size >= MAX_ACTIVE_NATIVE_SPEECH) {
    sendNativeAck('ptt.speech.ack', command.turnId, 'unavailable', { responseId: command.responseId, itemId: command.itemId });
    return;
  }
  const speech: ActiveNativeSpeech = {
    turnId: command.turnId,
    residentId: turn.residentId,
    residentSessionId: command.residentSessionId,
    responseId: command.responseId,
    itemId: command.itemId,
    samples: [],
    timer: setInterval(() => {
      const sample = sampleNativeSpeech(speech);
      if (!sample || speech.samples.length >= MAX_NATIVE_SPEECH_SAMPLES) {
        speech.samplingComplete = false;
        clearInterval(speech.timer);
        return;
      }
      speech.samples.push(sample);
    }, NATIVE_SPEECH_SAMPLE_INTERVAL_MS),
    samplingComplete: true,
  };
  const firstSample = sampleNativeSpeech(speech);
  if (!firstSample) {
    clearInterval(speech.timer);
    sendNativeAck('ptt.speech.ack', command.turnId, 'unavailable', { responseId: command.responseId, itemId: command.itemId });
    return;
  }
  speech.samples.push(firstSample);
  activeNativeSpeech.set(key, speech);
  sendNativeAck('ptt.speech.ack', command.turnId, 'started', { responseId: command.responseId, itemId: command.itemId });
}

function rememberHeardSpeech(
  event: Parameters<typeof heardSpeechMemory.remember>[0],
  attributedSpeakerName?: string,
): number {
  const speakerName = attributedSpeakerName ?? RESIDENT_DISPLAY_NAMES[event.speakerId as keyof typeof RESIDENT_DISPLAY_NAMES];
  if (!speakerName) return 0;
  return heardSpeechMemory.remember(event, speakerName);
}

function finishNativeSpeech(command: Extract<VillagePttCommand, { type: 'ptt.speech.finish' }>): void {
  prunePttTurns();
  const turn = activePttTurns.get(command.turnId);
  const key = nativeSpeechKey(command.turnId, command.responseId, command.itemId);
  const speech = activeNativeSpeech.get(key);
  if (!turn || turn.residentSessionId !== command.residentSessionId || !speech
    || speech.residentSessionId !== command.residentSessionId) {
    sendNativeAck('ptt.speech.ack', command.turnId, 'no_session', { responseId: command.responseId, itemId: command.itemId });
    return;
  }
  clearInterval(speech.timer);
  const finalSample = sampleNativeSpeech(speech);
  if (finalSample && speech.samples.length < MAX_NATIVE_SPEECH_SAMPLES) speech.samples.push(finalSample);
  else speech.samplingComplete = false;
  activeNativeSpeech.delete(key);

  const consumedResponseIds = consumedNativeSpeechResponseIds.get(command.residentSessionId) ?? new Set<string>();
  consumedNativeSpeechResponseIds.set(command.residentSessionId, consumedResponseIds);
  const event = projectCompletedResidentSpeech({
    session: {
      turnId: command.turnId,
      sessionId: command.residentSessionId,
      speakerId: turn.residentId,
      responseId: command.responseId,
      itemId: command.itemId,
    },
    playbackReport: {
      turnId: command.turnId,
      sessionId: command.residentSessionId,
      responseId: command.responseId,
      itemId: command.itemId,
      playback: command.playback,
      ...(command.transcript ? { transcript: command.transcript } : {}),
    },
    samples: speech.samplingComplete ? speech.samples : [],
    consumedResponseIds,
  });
  const recipientCount = event ? rememberHeardSpeech(event) : 0;
  sendNativeAck('ptt.speech.ack', command.turnId, 'finished', {
    responseId: command.responseId, itemId: command.itemId, recipientCount,
  });
}

function finishPlayerSpeech(command: Extract<VillagePttCommand, { type: 'ptt.player.speech.finish' }>): void {
  prunePttTurns();
  const turn = activePttTurns.get(command.turnId);
  if (!turn || turn.residentSessionId !== command.residentSessionId) {
    sendNativeAck('ptt.player.speech.ack', command.turnId, 'no_session', { itemId: command.itemId });
    return;
  }
  const itemIds = turn.playerSpeechItemIds ?? new Set<string>();
  turn.playerSpeechItemIds = itemIds;
  if (itemIds.has(command.itemId)) {
    sendNativeAck('ptt.player.speech.ack', command.turnId, 'duplicate', { itemId: command.itemId });
    return;
  }
  if ((turn.playerSpeechItems?.length ?? 0) >= MAX_PLAYER_SPEECH_ITEMS_PER_TURN) {
    sendNativeAck('ptt.player.speech.ack', command.turnId, 'too_many', { itemId: command.itemId });
    return;
  }
  turn.playerSpeechItems = [...(turn.playerSpeechItems ?? []), { itemId: command.itemId, transcript: command.transcript }];
  itemIds.add(command.itemId);
  sendNativeAck('ptt.player.speech.ack', command.turnId, 'queued', { itemId: command.itemId });
}

function finishQueuedPlayerSpeech(turn: ActivePttTurn): void {
  if (!turn.playerSpeechSamplingComplete || !turn.residentSessionId) return;
  const consumedItemIds = consumedPlayerSpeechItemIds.get(turn.residentSessionId) ?? new Set<string>();
  consumedPlayerSpeechItemIds.set(turn.residentSessionId, consumedItemIds);
  for (const item of turn.playerSpeechItems ?? []) {
    const event = projectCompletedPlayerSpeech({
      session: { turnId: turn.turnId, sessionId: turn.residentSessionId, itemId: item.itemId },
      report: { turnId: turn.turnId, sessionId: turn.residentSessionId, itemId: item.itemId, transcript: item.transcript },
      samples: turn.playerSpeechSamples ?? [], consumedItemIds,
    });
    if (event) rememberHeardSpeech(event, 'the player');
  }
}

function endNativeTurn(command: Extract<VillagePttCommand, { type: 'ptt.native.end' }>): void {
  const turn = activePttTurns.get(command.turnId);
  if (!turn || turn.residentSessionId !== command.residentSessionId) {
    sendNativeAck('ptt.native.ack', command.turnId, 'no_session');
    return;
  }
  stopNativeSpeechForTurn(command.turnId);
  stopPlayerSpeechSampling(turn, true);
  finishQueuedPlayerSpeech(turn);
  activePttTurns.delete(command.turnId);
  resolvedPttTurns.set(command.turnId, 'completed');
  sendNativeAck('ptt.native.ack', command.turnId, 'ended');
}

function prunePttTurns(now = Date.now()): void {
  for (const [turnId, turn] of activePttTurns) {
    if (now > turn.expiresAt) {
      stopNativeSpeechForTurn(turnId);
      stopPlayerSpeechSampling(turn, false);
      activePttTurns.delete(turnId);
      resolvedPttTurns.set(turnId, 'expired');
    }
  }
  while (resolvedPttTurns.size > 256) {
    const oldest = resolvedPttTurns.keys().next().value as string | undefined;
    if (!oldest) break;
    resolvedPttTurns.delete(oldest);
  }
}

function beginPttTurn(command: Extract<VillagePttCommand, { type: 'ptt.begin' | 'ptt.native.begin' }>): void {
  prunePttTurns();
  const existing = activePttTurns.get(command.turnId);
  if (existing) {
    sendPttAck(existing.beginAck);
    return;
  }
  if (resolvedPttTurns.has(command.turnId)) {
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId, status: 'duplicate' });
    return;
  }
  if (activePttTurns.size >= MAX_ACTIVE_PTT_TURNS) {
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId, status: 'unavailable' });
    return;
  }
  const explorer = currentExplorerPosition();
  const now = Date.now();
  const residents = currentEncounterResidents();
  const canRespond = ({ residentId, locationId }: EncounterResident): boolean => Boolean(selectResidentIntent(cognitionState.current, {
    residentId, playerIntent: 'greet', topic: 'general', locationId, tick: now,
  }, now >>> 0));
  const isNative = command.type === 'ptt.native.begin';
  const nearest = explorer ? selectPttResident(explorer, residents, isNative ? () => true : canRespond) : undefined;
  if (!nearest) {
    const guidance = explorer ? createNoResidentGuidance(explorer, residents, isNative ? () => true : canRespond)
      : 'No resident is available yet. Wait for the village to load, then approach a resident within 8 blocks.';
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId, status: 'no_resident', guidance });
    return;
  }
  const locationId = nearest.resident.locationId;
  const resident = freshPttBeginContext(nearest.resident.residentId, locationId);
  if (!resident) {
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId, status: 'no_resident' });
    return;
  }
  const beginAck: VillagePttAck = { version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId, status: 'ready', resident };
  const turn: ActivePttTurn = {
    turnId: command.turnId,
    residentId: resident.id,
    startedAt: command.at,
    expiresAt: Math.min(command.at + PTT_TURN_TTL_MS, Date.now() + PTT_TURN_TTL_MS),
    beginAck,
  };
  activePttTurns.set(command.turnId, turn);
  if (isNative) startPlayerSpeechSampling(turn);
  sendPttAck(beginAck);
}

function applyResidentAction(intent: SelectedResidentIntent, explorer: { x: number; y: number; z: number }): void {
  const bot = bots.get(intent.residentId);
  if (!bot) return;
  if (intent.action.kind === 'idle') {
    bot.pathfinder.setGoal(null);
    return;
  }
  if (intent.action.kind === 'look_at_player') {
    bot.pathfinder.setGoal(null);
    void bot.lookAt({ x: explorer.x, y: explorer.y + 1.5, z: explorer.z }, true).catch(() => undefined);
  }
}

function emitResidentResponse(turnId: string, intent: SelectedResidentIntent, line: string): string | null {
  const profile = villageProfiles.find(({ id }) => id === intent.residentId);
  const bot = bots.get(intent.residentId);
  if (!profile || !bot?.entity) return null;
  const eventId = `ptt-${turnId}`;
  const position = bot.entity.position.floored();
  const event = createVillageDialogueEvent({
    eventId,
    lineId: intent.speech.lineId,
    source: 'ptt-response',
    turnId,
    speakerId: profile.id,
    speakerName: profile.username,
    line,
    position: { x: position.x, y: position.y, z: position.z },
  });
  return emitVillageDialogueEvent(event);
}

function emitVillageDialogueEvent(event: VillageDialogueEvent): string | null {
  if (!event.eventId) return null;
  // PTT dialogue stays out of Minecraft chat/server logs; only the transient viewer event carries it.
  process.stdout.write(`${JSON.stringify(event)}\n`);
  return event.eventId;
}

function completePttTurn(command: Extract<VillagePttCommand, { type: 'ptt.complete' }>): void {
  prunePttTurns();
  const active = activePttTurns.get(command.turnId);
  if (!active) {
    const resolved = resolvedPttTurns.get(command.turnId);
    const status = resolved === 'expired' ? 'expired' : resolved === 'completed' ? 'duplicate' : 'no_session';
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status });
    return;
  }
  activePttTurns.delete(command.turnId);
  if (Date.now() > active.expiresAt) {
    resolvedPttTurns.set(command.turnId, 'cancelled');
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: 'expired' });
    return;
  }
  const explorer = currentExplorerPosition();
  const targetBot = bots.get(active.residentId);
  const targetDistance = explorer && targetBot?.entity ? distance3d(targetBot.entity.position, explorer) : Number.POSITIVE_INFINITY;
  if (!explorer || !targetBot?.entity || targetDistance > PLAYER_RESPONSE_RADIUS) {
    resolvedPttTurns.set(command.turnId, 'cancelled');
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: 'expired' });
    return;
  }

  const profile = villageProfiles.find(({ id }) => id === active.residentId);
  if (!profile) {
    resolvedPttTurns.set(command.turnId, 'cancelled');
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: 'no_session' });
    return;
  }
  const locationId = currentRoutineStop(active.residentId);
  const heardClaimEventId = latestHeardClaimEventId(cognitionState.current, active.residentId, 'tobin', 'route-mark');
  const semanticResponse = asSemanticResponse(command.response);
  const validatedResponse = semanticResponse
    ? validateSemanticResponse(semanticResponse, { residentId: active.residentId, context: getResidentKnowledgeContext(cognitionState.current, active.residentId) })
    : null;
  if (command.response !== null && !validatedResponse) {
    resolvedPttTurns.set(command.turnId, 'completed');
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: 'rejected' });
    return;
  }
  const fallback = command.response === null;
  const playerIntent = validatedResponse?.playerIntent ?? 'unknown';
  const topic = validatedResponse?.topic ?? 'general';
  const now = Date.now();
  const heardPlayerIntentEventId = latestHeardPlayerIntentEventId(
    cognitionState.current,
    active.residentId,
    'ask_for_help',
    'garden',
    now,
  );
  const nearbyResidentIds = getResidentsWithinHearingRadius(explorer, currentEncounterResidents());
  const playerObservation: VillageObservation = {
    type: 'player.intent',
    eventId: command.turnId,
    tick: now,
    recipientIds: nearbyResidentIds,
    intent: playerIntent,
    topic,
  };
  cognitionState.current = reduceVillageObservation(cognitionState.current, playerObservation);
  // A nearby held conversation is a low-stakes relationship signal; only a validated greeting counts as respectful.
  if (validatedResponse?.playerIntent === 'greet') {
    cognitionState.current = reduceVillageObservation(cognitionState.current, {
      type: 'player.behavior',
      eventId: `${command.turnId}:greet`,
      tick: now,
      recipientIds: [active.residentId],
      behavior: 'respectful_exchange',
    });
  }

  if (validatedResponse?.lineId.startsWith('equal-loaf.')) {
    const completion = completeEqualLoafPttTurn({
      state: cognitionState.current,
      sceneState: equalLoafSceneState,
      turnId: command.turnId,
      residentId: profile.id,
      residentName: profile.username,
      locationId,
      tick: now,
      semanticResponse: validatedResponse,
      explorerPosition: explorer,
      position: targetBot.entity.position,
      heardResidentIds: getResidentsWithinHearingRadius(targetBot.entity.position, currentEncounterResidents()),
      applyAction: applyResidentAction,
      emitDialogue: emitVillageDialogueEvent,
    });
    if (completion.status !== 'accepted') {
      resolvedPttTurns.set(command.turnId, 'completed');
      sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: completion.status });
      return;
    }
    cognitionState.current = completion.state;
    equalLoafSceneState = completion.sceneState;
    resolvedPttTurns.set(command.turnId, 'completed');
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: 'accepted',
      residentId: profile.id, speakerName: profile.username, lineId: completion.lineId, eventId: completion.eventId });
    return;
  }

  const localScene = {
    residentId: active.residentId,
    locationId,
    tick: now,
    ...(heardClaimEventId ? { heardClaimEventId } : {}),
    ...(heardPlayerIntentEventId ? { heardPlayerIntentEventId } : {}),
  };
  let intentContext: ResidentIntentContext = { ...localScene, playerIntent: 'greet', topic: 'general' };
  let intent: SelectedResidentIntent | null = null;
  if (validatedResponse) {
    const resolved = resolvePttResidentIntent(cognitionState.current, localScene, now >>> 0, validatedResponse);
    if (resolved) {
      intentContext = resolved.context;
      intent = resolved.intent;
    }
  } else {
    intent = selectResidentIntent(cognitionState.current, intentContext, now >>> 0);
  }
  if (!intent || !validateResidentIntent(cognitionState.current, intent, intentContext)) {
    resolvedPttTurns.set(command.turnId, 'completed');
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: 'rejected' });
    return;
  }
  const line = intent.speech.kind === 'authored_line' ? authoredLine(intent.speech.lineId) : null;
  if (!line) {
    resolvedPttTurns.set(command.turnId, 'completed');
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: 'rejected' });
    return;
  }

  applyResidentAction(intent, explorer);
  const eventId = emitResidentResponse(command.turnId, intent, line);
  if (!eventId) {
    resolvedPttTurns.set(command.turnId, 'completed');
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: 'rejected' });
    return;
  }
  cognitionState.current = reduceVillageObservation(cognitionState.current, {
    type: 'beat.completed',
    eventId: `${command.turnId}:beat`,
    tick: now,
    residentId: intent.residentId,
    beatId: intent.beatId,
  });
  resolvedPttTurns.set(command.turnId, 'completed');
  const status = fallback ? 'fallback' : 'accepted';
  sendPttAck({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status,
    residentId: profile.id, speakerName: profile.username, lineId: intent.speech.lineId, eventId });
}

function cancelPttTurn(command: Extract<VillagePttCommand, { type: 'ptt.cancel' }>): void {
  const resolved = resolvedPttTurns.get(command.turnId);
  if (resolved === 'expired') {
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'cancel', turnId: command.turnId, status: 'expired' });
    return;
  }
  if (resolved) {
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'cancel', turnId: command.turnId, status: 'duplicate' });
    return;
  }
  const active = activePttTurns.get(command.turnId);
  if (!active) {
    sendPttAck({ version: 1, type: 'ptt.ack', phase: 'cancel', turnId: command.turnId, status: 'no_session' });
    return;
  }
  stopNativeSpeechForTurn(command.turnId);
  stopPlayerSpeechSampling(active, false);
  activePttTurns.delete(command.turnId);
  resolvedPttTurns.set(command.turnId, 'cancelled');
  sendPttAck({ version: 1, type: 'ptt.ack', phase: 'cancel', turnId: command.turnId, status: 'cancelled' });
}

function handlePttCommand(command: VillagePttCommand): void {
  if (command.type === 'ptt.begin' || command.type === 'ptt.native.begin') beginPttTurn(command);
  else if (command.type === 'ptt.complete') completePttTurn(command);
  else if (command.type === 'ptt.cancel') cancelPttTurn(command);
  else if (command.type === 'ptt.session.bind') bindResidentSession(command);
  else if (command.type === 'ptt.speech.start') startNativeSpeech(command);
  else if (command.type === 'ptt.speech.finish') finishNativeSpeech(command);
  else if (command.type === 'ptt.player.speech.finish') finishPlayerSpeech(command);
  else endNativeTurn(command);
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const turn of activePttTurns.values()) stopPlayerSpeechSampling(turn, false);
  activePttTurns.clear();
  for (const speech of activeNativeSpeech.values()) clearInterval(speech.timer);
  activeNativeSpeech.clear();
  consumedNativeSpeechResponseIds.clear();
  consumedPlayerSpeechItemIds.clear();
  heardSpeechMemory.clear();
  clearInterval(heardSpeechMemoryPruner);
  for (const timer of awarenessTimers) clearInterval(timer);
  for (const bot of bots.values()) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.quit('Village simulator stopped');
  }
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const pttInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
pttInput.on('line', (line) => {
  if (Buffer.byteLength(line, 'utf8') > MAX_PTT_COMMAND_BYTES) return;
  let command: unknown;
  try { command = JSON.parse(line); } catch { return; }
  if (!isVillagePttCommand(command)) return;
  try {
    handlePttCommand(command);
  } catch {
    if (command.type === 'ptt.session.bind') sendNativeAck('ptt.session.ack', command.turnId, 'unavailable');
    else if (command.type === 'ptt.speech.start' || command.type === 'ptt.speech.finish') sendNativeAck('ptt.speech.ack', command.turnId, 'unavailable');
    else if (command.type === 'ptt.player.speech.finish') sendNativeAck('ptt.player.speech.ack', command.turnId, 'unavailable', { itemId: command.itemId });
    else if (command.type === 'ptt.native.end') sendNativeAck('ptt.native.ack', command.turnId, 'unavailable');
    else {
      const phase = command.type === 'ptt.begin' || command.type === 'ptt.native.begin' ? 'begin' : command.type === 'ptt.cancel' ? 'cancel' : 'complete';
      sendPttAck({ version: 1, type: 'ptt.ack', phase, turnId: command.turnId, status: 'unavailable' });
    }
  }
});
pttInput.on('error', () => undefined);

for (const profile of villageProfiles) {
  const bot = bots.get(profile.id);
  if (!bot) continue;
  bot.once('spawn', () => {
    const home = bot.entity.position;
    homePositions.set(profile.id, { x: Math.round(home.x), y: Math.round(home.y), z: Math.round(home.z) });
    const movements = new Movements(bot);
    movements.allowParkour = false;
    bot.pathfinder.setMovements(movements);
    bot.on('move', () => {
      const explorer = explorerFor(bot);
      if (explorer && bot.entity && shouldPauseForExplorer(distance3d(bot.entity.position, explorer.position))) bot.pathfinder.setGoal(null);
    });
    awarenessTimers.push(setInterval(() => { void watchExplorer(bot); }, 1_000));
    spawned.add(profile.id);
    process.stderr.write(`${profile.username} (${profile.role}; simulated NPC) joined at ${home.floored().toString()}\n`);
    if (spawned.size === villageProfiles.length) void runVillageRoutine();
  });
  bot.on('error', (error) => process.stderr.write(`${profile.username} connection error: ${error.message}\n`));
}

async function runVillageRoutine(): Promise<void> {
  for (const [index, profile] of villageProfiles.entries()) void runResidentRoutine(profile, index);
  for (const [index, profile] of villageProfiles.entries()) void runResidentDialogue(profile, index);
}

async function runResidentRoutine(profile: typeof villageProfiles[number], index: number): Promise<void> {
  let stopIndex = index % profile.routine.length;
  await wait(index * 2_500);
  while (!stopping) {
    const bot = bots.get(profile.id);
    const home = homePositions.get(profile.id);
    const stopAt = profile.routine[stopIndex % profile.routine.length];
    stopIndex += 1;
    if (!bot || !home || !stopAt) { await wait(1_000); continue; }
    const currentDistance = await watchExplorer(bot);
    if (currentDistance !== null && shouldPauseForExplorer(currentDistance)) {
      bot.pathfinder.setGoal(null);
      await wait(2_000);
      continue;
    }
    const action = process.env.BOSON_VILLAGE_AI === '1' ? await ai.chooseAction(profile.id, `walking toward ${stopAt.place}`) : null;
    if (stopping) break;
    process.stderr.write(`${JSON.stringify({ type: 'village.action', resident: profile.id, action: action ?? 'walk_to', target: stopAt.id, source: action ? 'jev' : 'local' })}\n`);
    if (action === 'stop' || action === 'idle') { await wait(profile.pauseMs); continue; }
    if (action === 'look_at' || action === 'turn_toward') {
      await watchExplorer(bot);
      await wait(profile.pauseMs);
      continue;
    }
    const target = getRoutineStopPosition(home, stopAt);
    const { x, y, z } = target;
    const explorer = explorerFor(bot);
    if (explorer && shouldPauseForExplorer(distance3d({ x, y, z }, explorer.position))) {
      await wait(2_000);
      continue;
    }
    try {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
      const observerPosition = bot.entity?.position;
      if (observerPosition) {
        const observation = createRoutineWorldObservation({
          stopId: stopAt.id,
          eventId: `routine-observation-${profile.id}-${++routineObservationSequence}`,
          tick: Date.now(),
          observerPosition: { x: observerPosition.x, y: observerPosition.y, z: observerPosition.z },
          hearingRadius: RESIDENT_HEARING_RADIUS,
          residents: villageProfiles.flatMap(({ id }) => {
            const residentBot = bots.get(id);
            const position = residentBot?.entity?.position;
            return position ? [{ id, position: { x: position.x, y: position.y, z: position.z } }] : [];
          }),
        });
        if (observation) cognitionState.current = reduceVillageObservation(cognitionState.current, observation);
      }
    } catch (error) {
      if (!stopping) process.stderr.write(`${profile.username} routine paused: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await wait(profile.pauseMs);
  }
}

const AMBIENT_DIALOGUE_CADENCE_MS = 20_000;

async function runResidentDialogue(profile: typeof villageProfiles[number], phaseIndex: number): Promise<void> {
  let cursor: ResidentDialogueCursor = { nextIndex: 0 };
  await wait(phaseIndex * 1_000);
  while (!stopping) {
    const scheduled = nextResidentDialogueTurn(profile.id, [...villageMysteryDialogue, ...villageDialogue], cursor);
    if (!scheduled) { await wait(AMBIENT_DIALOGUE_CADENCE_MS); continue; }
    cursor = scheduled.cursor;
    const turn = scheduled.turn;
    const clueId = turn.clueId && isPublicObservableFactId(turn.clueId) ? turn.clueId : undefined;
    const listener = villageProfiles.find(({ id }) => id === turn.listenerId);
    const bot = bots.get(turn.speakerId);
    const listenerBot = bots.get(turn.listenerId);
    if (!listener || !bot || !listenerBot || !bot.entity || !listenerBot.entity) { await wait(AMBIENT_DIALOGUE_CADENCE_MS); continue; }

    const turnKey = `${turn.speakerId}:${turn.listenerId}`;
    const options = villageDialogue
      .map((candidate, index) => ({ id: `ambient-${index}`, line: candidate.line, speakerId: candidate.speakerId, listenerId: candidate.listenerId }))
      .filter((candidate) => candidate.speakerId === turn.speakerId && candidate.listenerId === turn.listenerId)
      .map(({ id, line }) => ({ id, line }));
    const fallbackId = turn.clueId ? `mystery-${turn.clueId}` : `ambient-${villageDialogue.indexOf(turn)}`;
    if (!clueId && options.length > 1 && process.env.BOSON_VILLAGE_AI === '1' && ai.plannerDue()) {
      void ai.planDialogue({ speaker: profile.id, listener: listener.id, activity: profile.role, clueStage: 0, options }, fallbackId)
        .then((lineId) => { plannedLineIds.set(turnKey, lineId); })
        .catch(() => { /* Provider failures are handled inside the adapter; retain authored line. */ });
    }
    const selectedId = plannedLineIds.get(turnKey);
    const plannedOption = options.find(({ id }) => id === selectedId);
    const line = clueId ? turn.line : plannedOption?.line ?? turn.line;
    const position = bot.entity.position.floored();
    const eventId = `village-utterance-${++dialogueSequence}`;
    const observation = createAmbientUtteranceObservation({
      eventId, tick: Date.now(), speakerId: profile.id, turn,
      speakerPosition: { x: position.x, y: position.y, z: position.z },
      residents: villageProfiles.flatMap(({ id }) => {
        const residentBot = bots.get(id);
        const residentPosition = residentBot?.entity?.position;
        return residentPosition ? [{ id, position: { x: residentPosition.x, y: residentPosition.y, z: residentPosition.z } }] : [];
      }),
      hearingRadius: RESIDENT_HEARING_RADIUS,
    });
    if (observation) cognitionState.current = reduceVillageObservation(cognitionState.current, observation);
    bot.chat(line);
    const playerPosition = currentExplorerPosition();
    const lineId = clueId ? `mystery-${clueId}` : plannedOption?.id ?? fallbackId;
    const event = createVillageDialogueEvent({ eventId, lineId, source: 'ambient', speakerId: profile.id, speakerName: profile.username, line,
      position: { x: position.x, y: position.y, z: position.z }, listenerId: listener.id, listenerName: listener.username });
    if (playerPosition && distance3d(playerPosition, position) <= RESIDENT_HEARING_RADIUS) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    await wait(AMBIENT_DIALOGUE_CADENCE_MS);
  }
}

process.stderr.write('Village simulator started: three deterministic Mineflayer actors; chat and personality are simulated.\n');
