import { createGoalGateway } from './goal-gateway.ts';
import { loadMinecraftAdapter } from '../../minecraft/src/index.ts';

function integerFromEnv(value: string | undefined, fallback: number, variableName: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new TypeError(`${variableName} must be a valid TCP port`);
  return parsed;
}

const adapter = await loadMinecraftAdapter({
  host: process.env.BOSON_MC_HOST ?? '127.0.0.1',
  port: integerFromEnv(process.env.BOSON_MC_PORT, 25565, 'BOSON_MC_PORT'),
  username: process.env.BOSON_MC_USERNAME ?? 'BosonCompanion',
  playerName: process.env.BOSON_MC_PLAYER ?? 'DemoPlayer',
});

try {
  await adapter.connect();
  process.stdout.write(`Minecraft companion joined ${process.env.BOSON_MC_HOST ?? '127.0.0.1'}:${integerFromEnv(process.env.BOSON_MC_PORT, 25565, 'BOSON_MC_PORT')}\n`);
} catch (error) {
  process.stderr.write(`Minecraft adapter unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
}

const viewerPort = integerFromEnv(process.env.BOSON_VIEWER_PORT, 3000, 'BOSON_VIEWER_PORT');
let stopViewer: (() => Promise<void>) | undefined;
if (adapter.isReady) {
  try {
    stopViewer = await adapter.startViewer(viewerPort);
    process.stdout.write(`Minecraft 3D viewer listening on http://127.0.0.1:${viewerPort}\n`);
  } catch (error) {
    process.stderr.write(`Minecraft 3D viewer unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const { server } = createGoalGateway({
  execute: (goal, signal) => adapter.execute(goal, signal),
  isReady: () => adapter.isReady,
  observe: () => adapter.observe(),
  onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});

server.on('listening', () => process.stdout.write('Voice goal gateway listening on http://127.0.0.1:8001\n'));

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await stopViewer?.();
  await adapter.disconnect();
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
