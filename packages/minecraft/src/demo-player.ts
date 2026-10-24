import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { startPrismarineViewer } from './viewer.ts';

const { goals, Movements, pathfinder } = pathfinderPackage;
const host = process.env.BOSON_MC_HOST ?? '127.0.0.1';
const port = Number(process.env.BOSON_MC_PORT ?? 25565);
const username = process.env.BOSON_MC_PLAYER ?? 'DemoPlayer';
const pauseMs = Number(process.env.BOSON_EXPLORER_PAUSE_MS ?? 3_000);
const viewerPort = Number(process.env.BOSON_EXPLORER_VIEWER_PORT ?? 3000);
if (!new Set(['127.0.0.1', 'localhost', '::1']).has(host)) throw new TypeError('Demo player only connects to a loopback server');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('BOSON_MC_PORT must be a valid TCP port');
if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new TypeError('BOSON_MC_PLAYER must be a 3–16 character Minecraft username');
if (!Number.isInteger(pauseMs) || pauseMs < 500 || pauseMs > 60_000) {
  throw new TypeError('BOSON_EXPLORER_PAUSE_MS must be an integer between 500 and 60000');
}
if (!Number.isInteger(viewerPort) || viewerPort < 1 || viewerPort > 65_535) {
  throw new TypeError('BOSON_EXPLORER_VIEWER_PORT must be a valid TCP port');
}

const bot = mineflayer.createBot({ host, port, username, version: '1.21.11', auth: 'offline' });
bot.loadPlugin(pathfinder);

let stopping = false;
let stopViewer: (() => Promise<void>) | undefined;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
let resumePause: (() => void) | undefined;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    pauseTimer = setTimeout(() => {
      pauseTimer = undefined;
      resumePause = undefined;
      resolve();
    }, ms);
    resumePause = () => {
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = undefined;
      resumePause = undefined;
      resolve();
    };
  });
}

const stop = async () => {
  if (stopping) return;
  stopping = true;
  resumePause?.();
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

bot.once('spawn', () => {
  process.stdout.write(`Account-free explorer ${username} spawned at ${bot.entity.position.floored().toString()}\n`);
  const spawn = bot.entity.position.floored();
  const movements = new Movements(bot);
  movements.allowParkour = false;
  movements.allowSprinting = false;
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);
  void startPrismarineViewer(bot, viewerPort).then(async (closeViewer) => {
    stopViewer = closeViewer;
    process.stdout.write(`Explorer viewer listening on http://127.0.0.1:${viewerPort}\n`);
    if (stopping) await stopViewer();
  }).catch((error: unknown) => {
    process.stderr.write(`Explorer viewer lifecycle failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });

  // A compact loop through the resident waypoints keeps the camera near village life.
  const route: ReadonlyArray<readonly [number, number]> = [
    [5, 2], [2, -1], [0, -6], [-2, -7], [-5, 2], [-8, 0], [7, 4],
  ];
  void (async () => {
    let index = 0;
    while (!stopping) {
      const [offsetX, offsetZ] = route[index % route.length] ?? [0, 0];
      try {
        await bot.pathfinder.goto(new goals.GoalNear(spawn.x + offsetX, spawn.y, spawn.z + offsetZ, 1));
        if (stopping) break;
        process.stdout.write(`Explorer ${username} reached village waypoint ${index + 1}/${route.length} at ${bot.entity.position.floored().toString()}\n`);
        index += 1;
        await pause(pauseMs);
      } catch (error) {
        if (!stopping) {
          process.stderr.write(`Explorer stroll paused: ${error instanceof Error ? error.message : String(error)}\n`);
          await pause(1_000);
        }
      }
    }
  })();
});

bot.on('error', (error) => process.stderr.write(`Demo player error: ${error.message}\n`));
bot.on('end', () => { stopping = true; });
