import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { createVillageDialogueEvent } from './village-event.ts';
import { villageDialogue, villageMysteryDialogue, villageProfiles } from './village-profiles.ts';
import { distance3d, isWithinExplorerWatchRange, rendezvousExchange, shouldPauseForExplorer, VillageAi } from './village-ai.ts';

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
const meetingResidents = new Set<string>();
const lastWatchTurnAt = new Map<string, number>();
const awarenessTimers: ReturnType<typeof setInterval>[] = [];
const ai = new VillageAi({ enabled: process.env.BOSON_VILLAGE_AI === '1', jevKey: process.env.TYPESAFE_API_KEY, gatewayKey: process.env.AI_GATEWAY_API_KEY });
const plannedLineIds = new Map<string, string>();
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

function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const timer of awarenessTimers) clearInterval(timer);
  for (const bot of bots.values()) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.quit('Village simulator stopped');
  }
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

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
  void runVillageDialogue();
}

async function runResidentRoutine(profile: typeof villageProfiles[number], index: number): Promise<void> {
  let stopIndex = index % profile.routine.length;
  await wait(index * 2_500);
  while (!stopping) {
    if (meetingResidents.has(profile.id)) { await wait(500); continue; }
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
    const [offsetX, offsetZ] = stopAt.offset;
    const x = home.x + offsetX;
    const y = home.y;
    const z = home.z + offsetZ;
    const explorer = explorerFor(bot);
    if (explorer && shouldPauseForExplorer(distance3d({ x, y, z }, explorer.position))) {
      await wait(2_000);
      continue;
    }
    try {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
    } catch (error) {
      if (!stopping) process.stderr.write(`${profile.username} routine paused: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await wait(profile.pauseMs);
  }
}

async function runVillageDialogue(): Promise<void> {
  let turnIndex = 0;
  let clueIndex = 0;
  while (!stopping) {
    const isMystery = turnIndex >= villageDialogue.length;
    const ambientIndex = turnIndex;
    const turn = isMystery ? villageMysteryDialogue[(clueIndex++) % villageMysteryDialogue.length] : villageDialogue[turnIndex++];
    if (!turn) { await wait(1_000); continue; }
    const profile = villageProfiles.find(({ id }) => id === turn.speakerId);
    const listener = villageProfiles.find(({ id }) => id === turn.listenerId);
    const bot = bots.get(turn.speakerId);
    const listenerBot = bots.get(turn.listenerId);
    if (!profile || !listener || !bot || !listenerBot || !bot.entity || !listenerBot.entity) { await wait(2_000); continue; }
    const meetingStop = profile.routine.find(({ id }) => id === turn.stopId);
    const home = homePositions.get(profile.id);
    if (!meetingStop || !home) { await wait(2_000); continue; }
    const [offsetX, offsetZ] = meetingStop.offset;
    const target = { x: home.x + offsetX, y: home.y, z: home.z + offsetZ };
    meetingResidents.add(profile.id);
    meetingResidents.add(listener.id);
    bot.pathfinder.setGoal(null);
    listenerBot.pathfinder.setGoal(null);
    let met = false;
    try {
      met = await rendezvousExchange(profile.id, listener.id, target,
        async (residentId, place) => {
          const actor = bots.get(residentId);
          if (!actor) throw new Error('meeting resident unavailable');
          const radius = residentId === profile.id ? 1 : 3;
          await actor.pathfinder.goto(new goals.GoalNear(place.x, place.y, place.z, radius));
        },
        (residentId) => {
          const actor = bots.get(residentId);
          if (!actor?.entity) return null;
          const at = actor.entity.position;
          return { x: at.x, y: at.y, z: at.z };
        });
    } catch (error) {
      if (!stopping) process.stderr.write(`${profile.username} exchange rendezvous paused: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    meetingResidents.delete(profile.id);
    meetingResidents.delete(listener.id);
    if (!met || stopping) { await wait(1_000); continue; }

    const turnKey = `${turn.speakerId}:${turn.listenerId}`;
    const options = isMystery ? [] : villageDialogue
      .map((candidate, index) => ({ id: `ambient-${index}`, line: candidate.line, speakerId: candidate.speakerId, listenerId: candidate.listenerId }))
      .filter((candidate) => candidate.speakerId === turn.speakerId && candidate.listenerId === turn.listenerId)
      .map(({ id, line }) => ({ id, line }));
    const fallbackId = `ambient-${ambientIndex}`;
    if (!isMystery && options.length > 1 && process.env.BOSON_VILLAGE_AI === '1' && ai.plannerDue()) {
      void ai.planDialogue({ speaker: profile.id, listener: listener.id, activity: profile.role, clueStage: 0, options }, fallbackId)
        .then((lineId) => { plannedLineIds.set(turnKey, lineId); })
        .catch(() => { /* Provider failures are handled inside the adapter; retain authored line. */ });
    }
    const selectedId = plannedLineIds.get(turnKey);
    const plannedOption = options.find(({ id }) => id === selectedId);
    const line = plannedOption?.line ?? turn.line;
    const position = bot.entity.position.floored();
    bot.chat(line);
    const event = createVillageDialogueEvent({ speakerId: profile.id, speakerName: profile.username, line,
      position: { x: position.x, y: position.y, z: position.z }, listenerId: listener.id, listenerName: listener.username });
    // Preserve the existing JSONL viewer event contract.
    process.stdout.write(`${JSON.stringify(event)}\n`);
    await watchExplorer(bot);
    await wait(8_000);
  }
}

process.stderr.write('Village simulator started: three deterministic Mineflayer actors; chat and personality are simulated.\n');
