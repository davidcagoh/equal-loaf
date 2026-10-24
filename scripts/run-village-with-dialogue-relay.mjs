#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { isVillagePttCommand, MAX_PTT_COMMAND_BYTES } from '../packages/minecraft/src/village-event.ts';

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
const pendingAcks = new Map();
const ipcClients = new Set();
let ipcServer;

function bridgeError(status) {
  return { version: 1, type: 'ptt.bridge.ack', status };
}

function pttAckDescriptor(command, status) {
  if (command?.type?.startsWith('ptt.reaction.') && typeof command.reactionId === 'string') {
    return {
      version: 1,
      type: command.type === 'ptt.reaction.ack' ? 'ptt.reaction.ack' : 'ptt.reaction.speech.ack',
      reactionId: command.reactionId,
      eventId: command.eventId,
      residentId: command.residentId,
      ...(command.responseId ? { responseId: command.responseId } : {}),
      ...(command.itemId ? { itemId: command.itemId } : {}),
      status,
    };
  }
  if (!command || typeof command.turnId !== 'string') return bridgeError(status);
  if (command.type === 'ptt.begin' || command.type === 'ptt.native.begin' || command.type === 'ptt.complete' || command.type === 'ptt.cancel') {
    const phase = command.type === 'ptt.begin' || command.type === 'ptt.native.begin' ? 'begin' : command.type === 'ptt.cancel' ? 'cancel' : 'complete';
    return { version: 1, type: 'ptt.ack', phase, turnId: command.turnId, status };
  }
  const ackType = command.type === 'ptt.session.bind' ? 'ptt.session.ack'
    : command.type === 'ptt.speech.start' || command.type === 'ptt.speech.finish' ? 'ptt.speech.ack'
      : command.type === 'ptt.player.speech.finish' ? 'ptt.player.speech.ack'
      : command.type === 'ptt.native.end' ? 'ptt.native.ack' : null;
  if (!ackType) return bridgeError(status);
  return {
    version: 1, type: ackType, turnId: command.turnId, status,
    ...(command.responseId ? { responseId: command.responseId } : {}),
    ...(command.itemId ? { itemId: command.itemId } : {}),
  };
}

function ackKey(type, phase, turnId, responseId, itemId, reactionId) {
  return `${type}:${phase ?? ''}:${turnId ?? ''}:${responseId ?? ''}:${itemId ?? ''}:${reactionId ?? ''}`;
}

function deliverAck(event) {
  if (!event || !['ptt.ack', 'ptt.session.ack', 'ptt.speech.ack', 'ptt.player.speech.ack', 'ptt.native.ack', 'ptt.reaction.ack', 'ptt.reaction.speech.ack'].includes(event.type)
    || (typeof event.turnId !== 'string' && typeof event.reactionId !== 'string')) return false;
  const phase = event.type === 'ptt.ack' ? event.phase : undefined;
  const key = ackKey(event.type, phase, event.turnId, event.responseId, event.itemId, event.reactionId);
  const pending = pendingAcks.get(key);
  if (!pending) return true;
  clearTimeout(pending.timer);
  pendingAcks.delete(key);
  pending.socket.end(`${JSON.stringify(event)}\n`);
  return true;
}

function handleIpcLine(socket, line) {
  let command;
  try { command = JSON.parse(line); } catch { socket.end(`${JSON.stringify(bridgeError('invalid_json'))}\n`); return; }
  if (Buffer.byteLength(line, 'utf8') > MAX_PTT_COMMAND_BYTES || !isVillagePttCommand(command)) {
    socket.end(`${JSON.stringify(pttAckDescriptor(command, 'rejected'))}\n`);
    return;
  }
  if (!village.stdin?.writable || stopping) {
    socket.end(`${JSON.stringify(pttAckDescriptor(command, 'unavailable'))}\n`);
    return;
  }

  const errorAck = pttAckDescriptor(command, 'unavailable');
  const key = ackKey(errorAck.type, errorAck.phase, command.turnId, errorAck.responseId, errorAck.itemId, errorAck.reactionId);
  if (pendingAcks.has(key)) {
    socket.end(`${JSON.stringify(pttAckDescriptor(command, 'duplicate'))}\n`);
    return;
  }
  const timer = setTimeout(() => {
    pendingAcks.delete(key);
    socket.end(`${JSON.stringify(pttAckDescriptor(command, 'expired'))}\n`);
  }, 8_000);
  pendingAcks.set(key, { socket, timer });
  const body = `${JSON.stringify(command)}\n`;
  village.stdin.write(body, (error) => {
    if (!error) return;
    clearTimeout(timer);
    pendingAcks.delete(key);
    socket.end(`${JSON.stringify(pttAckDescriptor(command, 'unavailable'))}\n`);
  });
}

function startIpcBridge() {
  if (!ipcSocketPath) {
    process.stdout.write('Village turn IPC disabled; direct conversations unavailable.\n');
    return;
  }
  if (existsSync(ipcSocketPath)) throw new Error('Village IPC socket path already exists');
  ipcServer = createServer((socket) => {
    ipcClients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_PTT_COMMAND_BYTES + 1) {
        handled = true;
        socket.end(`${JSON.stringify(bridgeError('too_large'))}\n`);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      if (newline !== buffer.length - 1) {
        socket.end(`${JSON.stringify(bridgeError('invalid_frame'))}\n`);
        return;
      }
      handleIpcLine(socket, buffer.slice(0, newline));
    });
    socket.on('close', () => ipcClients.delete(socket));
    socket.on('error', () => ipcClients.delete(socket));
  });
  ipcServer.listen(ipcSocketPath, () => chmodSync(ipcSocketPath, 0o600));
  ipcServer.on('error', (error) => process.stderr.write(`Village IPC bridge failed: ${error.message}\n`));
}

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

async function relayNativeReaction(event) {
  try {
    const response = await fetch(`http://127.0.0.1:${viewerPort}/boson-ptt/reaction/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) process.stderr.write(`Native reaction dispatch rejected (${response.status}).\n`);
  } catch {
    process.stderr.write('Native reaction dispatch failed.\n');
  }
}

async function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  ipcServer?.close();
  for (const socket of ipcClients) socket.destroy();
  ipcClients.clear();
  for (const pending of pendingAcks.values()) {
    clearTimeout(pending.timer);
    pending.socket.end(`${JSON.stringify(bridgeError('unavailable'))}\n`);
  }
  pendingAcks.clear();
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
  ipcServer?.close();
  if (ipcSocketPath && existsSync(ipcSocketPath)) unlinkSync(ipcSocketPath);
});

process.stdout.write(`Village simulator active; forwarding dialogue to http://127.0.0.1:${viewerPort}/boson-dialogue\n`);
startIpcBridge();
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
  if (deliverAck(event)) continue;
  if (event?.type === 'village.residents') {
    void relayResidentPositions(event);
    continue;
  }
  if (event?.type === 'village.native.reaction') {
    void relayNativeReaction(event);
    continue;
  }
  if (event?.type !== 'village.dialogue') {
    process.stdout.write('Village simulator emitted a non-dialogue event.\n');
    continue;
  }

  void relayDialogue(event);
}

if (!stopping && village.exitCode === null && village.signalCode === null) await once(village, 'close');
