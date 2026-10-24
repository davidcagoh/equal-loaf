import mineflayer from 'mineflayer';
import { startPrismarineViewer } from './viewer.ts';

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

let stopping = false;
let stopViewer: (() => Promise<void>) | undefined;

const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
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
  void startPrismarineViewer(bot, viewerPort).then(async (closeViewer) => {
    stopViewer = closeViewer;
    process.stdout.write(`Explorer viewer listening on http://127.0.0.1:${viewerPort}\n`);
    if (stopping) await stopViewer();
  }).catch((error: unknown) => {
    process.stderr.write(`Explorer viewer lifecycle failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
});

bot.on('error', (error) => process.stderr.write(`Demo player error: ${error.message}\n`));
bot.on('end', () => { stopping = true; });
