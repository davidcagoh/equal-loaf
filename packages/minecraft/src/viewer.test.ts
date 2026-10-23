import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { startLoopbackViewer } from './viewer.ts';

const require = createRequire(import.meta.url);

test('binds the Prismarine HTTP viewer to loopback only', async () => {
  const probe = createServer();
  probe.listen(0);
  await new Promise<void>((resolve) => probe.once('listening', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  let server: Server | undefined;
  let requests = 0;
  const start = (_bot: object, options: { port: number }) => {
    server = createServer((_request, response) => {
      requests += 1;
      response.end('viewer');
    });
    server.listen(options.port, () => undefined);
  };
  const stop = await startLoopbackViewer({}, port, start);

  assert.ok(server);
  const bound = server.address();
  assert.ok(bound && typeof bound !== 'string');
  assert.equal(bound.address, '127.0.0.1');

  const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: 'http://127.0.0.1:8000' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), 'frame-ancestors http://127.0.0.1:8000 http://localhost:8000');
  const rejected = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: 'https://attacker.example' } });
  assert.equal(rejected.status, 403);
  assert.equal(requests, 1);

  let upgraded = false;
  const handshake = {
    headers: { host: `127.0.0.1:${port}`, origin: 'https://attacker.example' },
    url: '/socket.io/?EIO=4&transport=websocket',
  } as IncomingMessage;
  const socket = { end: () => { upgraded = true; } } as unknown as Duplex;
  server.emit('upgrade', handshake, socket, Buffer.alloc(0));
  assert.equal(upgraded, true);
  await stop();
});

test('rejects an occupied viewer port without an unhandled server error', async () => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => occupied.once('listening', resolve));
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const attempted: Server[] = [];

  const start = (_bot: object, options: { port: number }) => {
    const server = createServer();
    attempted.push(server);
    server.listen(options.port, () => undefined);
  };
  try {
    await assert.rejects(startLoopbackViewer({}, port, start), { code: 'EADDRINUSE' });
    assert.equal(attempted[0]?.listening, false);
  } finally {
    if (attempted[0]?.listening) await new Promise<void>((resolve) => attempted[0]?.close(() => resolve()));
    if (occupied.listening) await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test('preserves negative world-height metadata across Prismarine chunk JSON', () => {
  const Chunk = require('prismarine-chunk')('1.21.11');
  const Vec3 = require('vec3').Vec3;
  const minecraftData = require('minecraft-data')('1.21.4');
  const World = require('../node_modules/prismarine-viewer/viewer/lib/world.js').World;
  const sourceChunk = new Chunk({ minY: -64, worldHeight: 384 });
  sourceChunk.setBlockStateId(new Vec3(1, -60, 1), minecraftData.blocksByName.stone.minStateId);

  const serializedChunk = JSON.stringify({
    ...JSON.parse(sourceChunk.toJson()),
    minY: sourceChunk.minY,
    worldHeight: sourceChunk.worldHeight,
  });
  const world = new World('1.21.4');
  const restoredChunk = world.addColumn(0, 0, serializedChunk);

  assert.equal(restoredChunk.minY, -64);
  assert.equal(restoredChunk.worldHeight, 384);
  assert.equal(world.getBlock(new Vec3(1, -60, 1)).name, 'stone');
});

test('limits the browser viewer to one chunk-meshing worker', () => {
  const Viewer = require('../node_modules/prismarine-viewer/viewer/lib/viewer.js').Viewer;
  const previousWorker = globalThis.Worker;
  let createdWorkers = 0;
  class StubWorker {
    onmessage?: (event: { data: unknown }) => void;

    constructor() {
      createdWorkers += 1;
    }

    postMessage(): void {}
  }
  globalThis.Worker = StubWorker as unknown as typeof Worker;

  try {
    const viewer = new Viewer({ getSize: (size: { set: (width: number, height: number) => unknown }) => size.set(800, 600), domElement: {} });
    assert.equal(viewer.world.workers.length, 1);
    assert.equal(createdWorkers, 1);
  } finally {
    globalThis.Worker = previousWorker;
  }
});

test('sends the current companion position to a viewer client without waiting for movement', async () => {
  const { EventEmitter } = require('node:events');
  const { mineflayer } = require('prismarine-viewer') as { mineflayer: (bot: object, options: { port: number }) => void };
  const ioClient = require('socket.io-client') as (url: string, options: { path: string }) => {
    on(event: string, listener: (value: unknown) => void): void;
    disconnect(): void;
  };
  const probe = createServer();
  probe.listen(0);
  await new Promise<void>((resolve) => probe.once('listening', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const bot = new EventEmitter() as EventEmitter & {
    version: string;
    username: string;
    entity: { position: InstanceType<typeof Vec3>; yaw: number; pitch: number };
    world: { getColumnAt: () => Promise<null>; raycast: () => null };
    entities: Record<string, never>;
    viewer?: { close: () => void };
  };
  const Vec3 = require('vec3').Vec3 as typeof import('vec3').Vec3;
  bot.version = '1.21.11';
  bot.username = 'BosonCompanion';
  bot.entity = { position: new Vec3(12, 64, -8), yaw: 0.25, pitch: 0 };
  bot.world = { getColumnAt: async () => null, raycast: () => null };
  bot.entities = {};

  mineflayer(bot, { port });
  const socket = ioClient(`http://127.0.0.1:${port}`, { path: '/socket.io' });
  try {
    const position = await new Promise<{ pos: { x: number; y: number; z: number }; yaw: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Viewer did not send initial companion position')), 3_000);
      socket.on('position', (value) => {
        clearTimeout(timeout);
        resolve(value as { pos: { x: number; y: number; z: number }; yaw: number });
      });
    });
    assert.deepEqual(position.pos, { x: 12, y: 64, z: -8 });
    assert.equal(position.yaw, 0.25);
  } finally {
    socket.disconnect();
    bot.viewer?.close();
  }
});
