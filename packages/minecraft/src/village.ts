import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { villageProfiles } from './village-profiles.ts';

const { goals, Movements, pathfinder } = pathfinderPackage;

const host = process.env.BOSON_MC_HOST ?? '127.0.0.1';
const port = Number(process.env.BOSON_MC_PORT ?? 25565);
if (!new Set(['127.0.0.1', 'localhost', '::1']).has(host)) throw new TypeError('Village actors only connect to a loopback server');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('BOSON_MC_PORT must be a valid TCP port');

let stopping = false;
const bots = villageProfiles.map(({ username }) => {
  const bot = mineflayer.createBot({ host, port, username, version: '1.21.11', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  return bot;
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const bot of bots) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.quit('Village simulator stopped');
  }
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

for (const [index, profile] of villageProfiles.entries()) {
  const bot = bots[index];
  if (!bot) continue;
  bot.once('spawn', () => {
    process.stdout.write(`${profile.username} (${profile.role}; simulated NPC) joined at ${bot.entity.position.floored().toString()}\n`);
    const homeX = Math.round(bot.entity.position.x);
    const homeY = Math.round(bot.entity.position.y);
    const homeZ = Math.round(bot.entity.position.z);
    const movements = new Movements(bot);
    movements.allowParkour = false;
    bot.pathfinder.setMovements(movements);
    void (async () => {
      let turn = 0;
      while (!stopping) {
        const angle = (turn % 4) * Math.PI / 2;
        const [offsetX, offsetZ] = profile.offset;
        const radius = turn % 2 === 0 ? 2 : 4;
        const x = Math.round(homeX + offsetX + Math.cos(angle) * radius);
        const z = Math.round(homeZ + offsetZ + Math.sin(angle) * radius);
        try {
          await bot.pathfinder.goto(new goals.GoalNear(x, homeY, z, 1));
          if (stopping) break;
          bot.chat(profile.lines[turn % profile.lines.length] ?? 'Hello from the village.');
          turn += 1;
        } catch (error) {
          if (!stopping) process.stderr.write(`${profile.username} routine paused: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        await wait(profile.pauseMs);
      }
    })();
  });
  bot.on('error', (error) => process.stderr.write(`${profile.username} connection error: ${error.message}\n`));
}

process.stdout.write('Village simulator started: three deterministic Mineflayer actors; chat and personality are simulated.\n');
