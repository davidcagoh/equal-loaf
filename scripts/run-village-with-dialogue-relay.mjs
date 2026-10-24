#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createVillagePttIpcBridge } from './village-ptt-ipc-bridge.mjs';

const viewerPort = Number(process.env.BOSON_EXPLORER_VIEWER_PORT ?? process.env.BOSON_VIEWER_PORT ?? 3000);
if (!Number.isInteger(viewerPort) || viewerPort < 1 || viewerPort > 65_535) {
  throw new TypeError('BOSON_VIEWER_PORT must be a valid TCP port');
}

const projectRoot = new URL('../', import.meta.url);
const villageScript = new URL('../packages/minecraft/src/village.ts', import.meta.url);
const ipcSocketPath = process.env.BOSON_VILLAGE_IPC_SOCKET;
const village = spawn(process.execPath, ['--experimental-strip-types', villageScript.pathname], {
  cwd: projectRoot,
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});
let stopping = false;
const ipcBridge = createVillagePttIpcBridge({ socketPath: ipcSocketPath, village,
  isStopping: () => stopping, onError: (error) => process.stderr.write(`Village IPC bridge failed: ${error.message}\n`) });

async function relayDialogue(event) {
  try {
    const response = await fetch(`http://127.0.0.1:${viewerPort}/boson-dialogue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status !== 202) {
      process.stderr.write(`Dialogue relay rejected event (${response.status}).\n`);
    } else {
      process.stdout.write('Relayed village dialogue event.\n');
    }
  } catch (error) {
    process.stderr.write(`Dialogue relay failed: ${error instanceof Error ? error.name : 'unknown error'}\n`);
  }
}

async function relayResidentPositions(event) {
  try {
    await fetch(`http://127.0.0.1:${viewerPort}/boson-residents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    // Position refresh is transient; the viewer will receive the next snapshot.
  }
}

async function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  ipcBridge.close();
  const closed = once(village, 'close');
  village.kill(signal);
  let timer;
  const exited = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
  ]);
  clearTimeout(timer);
  if (!exited) {
    village.kill('SIGKILL');
    await closed;
  }
}

process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });
village.once('error', (error) => process.stderr.write(`Could not start village simulator: ${error.message}\n`));
village.once('close', (code, signal) => {
  if (!stopping) process.exitCode = code ?? (signal ? 1 : 0);
  stopping = true;
  ipcBridge.close();
});

process.stdout.write(`Village simulator active; forwarding dialogue to http://127.0.0.1:${viewerPort}/boson-dialogue\n`);
if (!ipcSocketPath) process.stdout.write('Village turn IPC disabled; direct conversations unavailable.\n');
else await ipcBridge.start();
const lines = createInterface({ input: village.stdout, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    continue;
  }
  if (ipcBridge.deliverAck(event)) continue;
  if (event?.type === 'village.residents') {
    void relayResidentPositions(event);
    continue;
  }
  if (event?.type !== 'village.dialogue') {
    process.stdout.write('Village simulator emitted a non-dialogue event.\n');
    continue;
  }

  void relayDialogue(event);
}

if (!stopping && village.exitCode === null && village.signalCode === null) await once(village, 'close');
