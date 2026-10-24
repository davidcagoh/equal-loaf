import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createVillagePttIpcBridge } from './village-ptt-ipc-bridge.mjs';

test('player-speech acknowledgement is delivered by item correlation through the production IPC bridge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boson-ptt-bridge-'));
  const socketPath = join(directory, 'village.sock');
  const village = { stdin: new PassThrough(), stdout: new PassThrough() };
  const bridge = createVillagePttIpcBridge({ socketPath, village });
  try {
    await bridge.start();
    const command = { version: 1, type: 'ptt.player.speech.finish', turnId: 'turn_00000001',
      residentSessionId: 'session_pip_0001', itemId: 'input_item_1', transcript: 'The gardens need water.', at: Date.now() };
    const responsePromise = new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once('error', reject);
      socket.once('data', (data) => resolve(JSON.parse(String(data))));
      socket.write(`${JSON.stringify(command)}\n`);
    });
    const forwarded = await new Promise((resolve) => village.stdin.once('data', (data) => resolve(JSON.parse(String(data)))));
    assert.deepEqual(forwarded, command);
    const acknowledgement = { version: 1, type: 'ptt.player.speech.ack', turnId: command.turnId, itemId: command.itemId, status: 'queued' };
    assert.equal(bridge.deliverAck(acknowledgement), true);
    assert.deepEqual(await responsePromise, acknowledgement);
  } finally {
    bridge.close();
    village.stdin.destroy(); village.stdout.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
