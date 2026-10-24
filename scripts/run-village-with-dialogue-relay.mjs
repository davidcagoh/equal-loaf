#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const viewerPort = Number(process.env.BOSON_EXPLORER_VIEWER_PORT ?? process.env.BOSON_VIEWER_PORT ?? 3000);
if (!Number.isInteger(viewerPort) || viewerPort < 1 || viewerPort > 65_535) {
  throw new TypeError('BOSON_VIEWER_PORT must be a valid TCP port');
}

const projectRoot = new URL('../', import.meta.url);
const villageScript = new URL('../packages/minecraft/src/village.ts', import.meta.url);
const village = spawn(process.execPath, ['--experimental-strip-types', villageScript.pathname], {
  cwd: projectRoot,
  env: process.env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
let stopping = false;

async function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
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
});

process.stdout.write(`Village simulator active; forwarding dialogue to http://127.0.0.1:${viewerPort}/boson-dialogue\n`);
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
  if (event?.type !== 'village.dialogue') {
    process.stdout.write(`${line}\n`);
    continue;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${viewerPort}/boson-dialogue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status !== 202) {
      process.stderr.write(`Dialogue relay rejected event (${response.status}): ${await response.text()}\n`);
    } else {
      process.stdout.write(`Relayed dialogue · ${event.speakerName}: ${event.line}\n`);
    }
  } catch (error) {
    process.stderr.write(`Dialogue relay failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

if (!stopping && village.exitCode === null && village.signalCode === null) await once(village, 'close');
