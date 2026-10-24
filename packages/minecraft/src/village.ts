import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { createVillageDialogueEvent } from './village-event.ts';
import { villageDialogue, villageProfiles } from './village-profiles.ts';

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stop(): void {
  if (stopping) return;
  stopping = true;
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
    spawned.add(profile.id);
    process.stderr.write(`${profile.username} (${profile.role}; simulated NPC) joined at ${home.floored().toString()}\n`);
    if (spawned.size === villageProfiles.length) void runVillageRoutine();
  });
  bot.on('error', (error) => process.stderr.write(`${profile.username} connection error: ${error.message}\n`));
}

async function runVillageRoutine(): Promise<void> {
  let turnIndex = 0;
  while (!stopping) {
    const turn = villageDialogue[turnIndex % villageDialogue.length];
    turnIndex += 1;
    const profile = villageProfiles.find(({ id }) => id === turn?.speakerId);
    const listener = villageProfiles.find(({ id }) => id === turn?.listenerId);
    const bot = turn ? bots.get(turn.speakerId) : undefined;
    const listenerBot = turn ? bots.get(turn.listenerId) : undefined;
    const home = turn ? homePositions.get(turn.speakerId) : undefined;
    const stopAt = profile?.routine.find(({ id }) => id === turn?.stopId);
    if (!turn || !profile || !listener || !bot || !listenerBot || !home || !stopAt) continue;

    const [offsetX, offsetZ] = stopAt.offset;
    const x = home.x + offsetX;
    const y = home.y;
    const z = home.z + offsetZ;
    try {
      await Promise.all([
        bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)),
        listenerBot.pathfinder.goto(new goals.GoalNear(x, y, z, 3)),
      ]);
      if (stopping) break;
      const position = bot.entity.position.floored();
      bot.chat(turn.line);
      const event = createVillageDialogueEvent({
        speakerId: profile.id,
        speakerName: profile.username,
        line: turn.line,
        position: { x: position.x, y: position.y, z: position.z },
        listenerId: listener.id,
        listenerName: listener.username,
      });
      // stdout is a machine-readable JSONL event stream consumed by the local demo launcher.
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } catch (error) {
      if (!stopping) process.stderr.write(`${profile.username} routine paused: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await wait(profile.pauseMs);
  }
}

process.stderr.write('Village simulator started: three deterministic Mineflayer actors; chat and personality are simulated.\n');
