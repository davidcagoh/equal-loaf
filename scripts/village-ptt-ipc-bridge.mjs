import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { isVillagePttCommand, MAX_PTT_COMMAND_BYTES } from '../packages/minecraft/src/village-event.ts';

function bridgeError(status) {
  return { version: 1, type: 'ptt.bridge.ack', status };
}

function pttAckDescriptor(command, status) {
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

function ackKey(type, phase, turnId, responseId, itemId) {
  return `${type}:${phase ?? ''}:${turnId}:${responseId ?? ''}:${itemId ?? ''}`;
}

export function createVillagePttIpcBridge({ socketPath, village, isStopping = () => false, onError = () => {}, timeoutMs = 8_000 }) {
  const pendingAcks = new Map();
  const ipcClients = new Set();
  let ipcServer;

  function deliverAck(event) {
    if (!event || !['ptt.ack', 'ptt.session.ack', 'ptt.speech.ack', 'ptt.player.speech.ack', 'ptt.native.ack'].includes(event.type)
      || typeof event.turnId !== 'string') return false;
    const phase = event.type === 'ptt.ack' ? event.phase : undefined;
    const key = ackKey(event.type, phase, event.turnId, event.responseId, event.itemId);
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
    if (!village.stdin?.writable || isStopping()) {
      socket.end(`${JSON.stringify(pttAckDescriptor(command, 'unavailable'))}\n`);
      return;
    }

    const errorAck = pttAckDescriptor(command, 'unavailable');
    const key = ackKey(errorAck.type, errorAck.phase, command.turnId, errorAck.responseId, errorAck.itemId);
    if (pendingAcks.has(key)) {
      socket.end(`${JSON.stringify(pttAckDescriptor(command, 'duplicate'))}\n`);
      return;
    }
    const timer = setTimeout(() => {
      pendingAcks.delete(key);
      socket.end(`${JSON.stringify(pttAckDescriptor(command, 'expired'))}\n`);
    }, timeoutMs);
    pendingAcks.set(key, { socket, timer });
    const body = `${JSON.stringify(command)}\n`;
    village.stdin.write(body, (error) => {
      if (!error) return;
      clearTimeout(timer);
      pendingAcks.delete(key);
      socket.end(`${JSON.stringify(pttAckDescriptor(command, 'unavailable'))}\n`);
    });
  }

  function start() {
    if (!socketPath) return Promise.resolve(false);
    if (existsSync(socketPath)) return Promise.reject(new Error('Village IPC socket path already exists'));
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
    ipcServer.on('error', onError);
    return new Promise((resolve, reject) => {
      ipcServer.once('error', reject);
      ipcServer.listen(socketPath, () => {
        ipcServer.removeListener('error', reject);
        chmodSync(socketPath, 0o600);
        resolve(true);
      });
    });
  }

  function close() {
    ipcServer?.close();
    for (const socket of ipcClients) socket.destroy();
    ipcClients.clear();
    for (const pending of pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.socket.end(`${JSON.stringify(bridgeError('unavailable'))}\n`);
    }
    pendingAcks.clear();
    if (socketPath && existsSync(socketPath)) unlinkSync(socketPath);
  }

  return { start, deliverAck, close };
}
