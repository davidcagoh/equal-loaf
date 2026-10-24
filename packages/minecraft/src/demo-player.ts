import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { startPrismarineViewer } from './viewer.ts';
import { VILLAGE_WALKIN_POINT } from './village-arrival.ts';

const { goals, Movements, pathfinder } = pathfinderPackage;

const host = process.env.BOSON_MC_HOST ?? '127.0.0.1';
const port = Number(process.env.BOSON_MC_PORT ?? 25565);
const username = process.env.BOSON_MC_PLAYER ?? 'DemoPlayer';
const viewerPort = Number(process.env.BOSON_EXPLORER_VIEWER_PORT ?? 3000);
if (!new Set(['127.0.0.1', 'localhost', '::1']).has(host)) throw new TypeError('Demo player only connects to a loopback server');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('BOSON_MC_PORT must be a valid TCP port');
if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new TypeError('BOSON_MC_PLAYER must be a 3–16 character Minecraft username');
if (!Number.isInteger(viewerPort) || viewerPort < 1 || viewerPort > 65_535) {
  throw new TypeError('BOSON_EXPLORER_VIEWER_PORT must be a valid TCP port');
}

const bot = mineflayer.createBot({ host, port, username, version: '1.21.11', auth: 'offline' });
bot.loadPlugin(pathfinder);

let stopping = false;
let stopViewer: (() => Promise<void>) | undefined;

const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
      bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.quit('Demo player stopped');
  } catch (error) {
    process.stderr.write(`Explorer bot shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  try {
    await stopViewer?.();
  } catch (error) {
    process.stderr.write(`Explorer viewer shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
bot.once('end', () => { void stop(); });

async function walkIntoVillageSquare(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const movements = new Movements(bot);
    movements.allowParkour = false;
    bot.pathfinder.setMovements(movements);
    const result = await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(VILLAGE_WALKIN_POINT.x, VILLAGE_WALKIN_POINT.y, VILLAGE_WALKIN_POINT.z, 2))
        .then(() => 'arrived' as const, () => 'unreachable' as const),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 20_000); }),
    ]);
    if (result !== 'arrived') {
      process.stderr.write(`Explorer arrival path ${result}; keeping the current spawn position.\n`);
      return;
    }
    const position = bot.entity.position.floored();
    process.stdout.write(`Explorer walked into the village square at ${position.toString()}.\n`);
  } catch {
    process.stderr.write('Explorer arrival setup failed; keeping the current spawn position.\n');
  } finally {
    if (timer) clearTimeout(timer);
    try {
      bot.pathfinder.setGoal(null);
    } catch {
      process.stderr.write('Explorer arrival goal cleanup failed.\n');
    }
    try {
      bot.clearControlStates();
    } catch {
      process.stderr.write('Explorer arrival control cleanup failed.\n');
    }
  }
}

async function startExplorerViewer(): Promise<void> {
  await walkIntoVillageSquare();
  if (stopping) return;
  process.stdout.write(`Account-free explorer ${username} spawned at ${bot.entity.position.floored().toString()}\n`);
  void startPrismarineViewer(bot, viewerPort).then(async (closeViewer) => {
    stopViewer = closeViewer;
    process.stdout.write(`Explorer viewer listening on http://127.0.0.1:${viewerPort}\n`);
    if (stopping) await stopViewer();
  }).catch((error: unknown) => {
    process.stderr.write(`Explorer viewer lifecycle failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

bot.once('spawn', () => {
  void startExplorerViewer().catch((error: unknown) => {
    process.stderr.write(`Explorer startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
});

bot.on('error', (error) => process.stderr.write(`Demo player error: ${error.message}\n`));
bot.on('end', () => { stopping = true; });
