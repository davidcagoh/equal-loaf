import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { startLoopbackViewer } from './viewer.ts';
import { isVillageDialogue, volumeForDistance } from './viewer-audio.js';

const require = createRequire(import.meta.url);

test('maps greater explorer distance to lower speech volume and validates dialogue events', () => {
  assert.ok(volumeForDistance(2) > volumeForDistance(12));
  assert.ok(volumeForDistance(12) > volumeForDistance(40));
  assert.ok(volumeForDistance(100) > volumeForDistance(200));
  assert.equal(isVillageDialogue({
    type: 'village.dialogue', speakerId: 'a', speakerName: 'A', line: 'hello',
    position: { x: 1, y: 2, z: 3 }, timestamp: 10,
  }), true);
  assert.equal(isVillageDialogue({ type: 'village.dialogue', line: 'bad' }), false);
});

test('serves subtitles client and relays validated dialogue over same-origin SSE', async () => {
  const probe = createServer();
  probe.listen(0);
  await new Promise<void>((resolve) => probe.once('listening', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  let server: Server | undefined;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = await startLoopbackViewer({}, port, (_bot, options) => {
    server = createServer((_request, response) => response.end('viewer'));
    server.listen(options.port, () => undefined);
  });
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.match(await page.text(), /boson-audio\.js/);
    const stream = await fetch(`http://127.0.0.1:${port}/boson-dialogue`, { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(stream.status, 200);
    activeReader = stream.body?.getReader();
    assert.ok(activeReader);
    await activeReader.read();
    const event = { type: 'village.dialogue', speakerId: 'mira', speakerName: 'Mira', line: 'Good morning.', position: { x: 0, y: 64, z: 0 }, timestamp: 123 };
    const response = await fetch(`http://127.0.0.1:${port}/boson-dialogue`, {
      method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify(event),
    });
    assert.equal(response.status, 202);
    const message = await activeReader.read();
    assert.match(new TextDecoder().decode(message.value), /event: dialogue[\s\S]*Mira/);
    const invalid = await fetch(`http://127.0.0.1:${port}/boson-dialogue`, {
      method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(invalid.status, 400);
    const rejected = await fetch(`http://127.0.0.1:${port}/boson-dialogue`, {
      method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify(event),
    });
    assert.equal(rejected.status, 403);
  } finally {
    await stop();
    if (activeReader) assert.equal((await activeReader.read()).done, true);
  }
});

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

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: 'http://127.0.0.1:8000' } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), 'frame-ancestors http://127.0.0.1:8000 http://localhost:8000');
    assert.match(await page.text(), /boson-audio\.js/);
    const rejected = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: 'https://attacker.example' } });
    assert.equal(rejected.status, 403);
    const fallback = await fetch(`http://127.0.0.1:${port}/fallback`, { headers: { origin: 'http://127.0.0.1:8000' } });
    assert.equal(fallback.status, 200);
    assert.equal(requests, 1);

    let upgraded = false;
    const handshake = {
      headers: { host: `127.0.0.1:${port}`, origin: 'https://attacker.example' },
      url: '/socket.io/?EIO=4&transport=websocket',
    } as IncomingMessage;
    const socket = { end: () => { upgraded = true; } } as unknown as Duplex;
    server.emit('upgrade', handshake, socket, Buffer.alloc(0));
    assert.equal(upgraded, true);
  } finally {
    await stop();
  }
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

test('stops the viewer promptly with an open WebSocket client', async () => {
  const probe = createServer();
  probe.listen(0);
  await new Promise<void>((resolve) => probe.once('listening', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const server = createServer();
  let viewerSocket: Duplex | undefined;
  server.on('upgrade', (_request, socket) => {
    viewerSocket = socket;
    const key = _request.headers['sec-websocket-key'];
    assert.equal(typeof key, 'string');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const stop = await startLoopbackViewer({}, port, (_bot, options) => server.listen(options.port, () => undefined));
  const socket = createConnection(port, '127.0.0.1');
  let stopPromise: Promise<void> | undefined;
  let stopTimeout: NodeJS.Timeout | undefined;
  let handshakeTimeout: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        handshakeTimeout = setTimeout(() => reject(new Error('Viewer WebSocket handshake timed out')), 3_000);
        socket.once('data', (data) => {
          if (handshakeTimeout) clearTimeout(handshakeTimeout);
          if (data.toString().startsWith('HTTP/1.1 101')) resolve();
          else reject(new Error('Viewer did not accept the WebSocket handshake'));
        });
        socket.write([
          'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          `Origin: http://127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'));
      });
      socket.once('error', reject);
    });

    await Promise.race([
      (stopPromise = stop()),
      new Promise<never>((_resolve, reject) => {
        stopTimeout = setTimeout(() => reject(new Error('Viewer shutdown waited on an open WebSocket')), 1_000);
      }),
    ]);
    assert.equal(server.listening, false);
    assert.equal(viewerSocket?.destroyed, true);
  } finally {
    if (stopTimeout) clearTimeout(stopTimeout);
    if (handshakeTimeout) clearTimeout(handshakeTimeout);
    socket.destroy();
    viewerSocket?.destroy();
    if (stopPromise) await stopPromise;
    else await stop();
  }
});
