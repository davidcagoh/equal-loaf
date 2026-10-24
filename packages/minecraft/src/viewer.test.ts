import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createServer, get as httpGet, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { startLoopbackViewer } from './viewer.ts';
import { isVillageDialogue, volumeForDistance } from './viewer-audio.js';

const require = createRequire(import.meta.url);
const { normalizeCameraHelpSource } = require('../scripts/prismarine-viewer-patch.cjs') as {
  normalizeCameraHelpSource(source: string): string;
};
const followCamera = require('../scripts/follow-camera.cjs') as {
  viewDirection(yaw: number, pitch: number): { x: number; y: number; z: number };
  cameraPosition(position: { x: number; y: number; z: number }, yaw: number, pitch: number, eyeHeight: number, distance: number): { x: number; y: number; z: number };
  interpolateAngle(current: number, target: number, amount: number): number;
  selectNearbySectionMeshes(sectionMeshes: Record<string, unknown>, start: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }, radius?: number, sectionSize?: number): unknown[];
  resolveBoomDistance(distance: number, hitDistances: number[], clearance?: number, minDistance?: number): number;
};

test('builds a rear camera pose from the Mineflayer view angles', () => {
  const direction = followCamera.viewDirection(0, 0);
  assert.ok(Math.abs(direction.x) < 1e-12);
  assert.equal(direction.y, 0);
  assert.equal(direction.z, -1);

  const behindNorth = followCamera.cameraPosition({ x: 10, y: 64, z: 20 }, 0, 0, 1.62, 3.5);
  assert.deepEqual(behindNorth, { x: 10, y: 65.62, z: 23.5 });
  const lookDown = followCamera.cameraPosition({ x: 0, y: 0, z: 0 }, 0, Math.PI / 4, 1.6, 4);
  assert.ok(lookDown.y < 1.6);
  assert.ok(lookDown.z > 0);
});

test('interpolates yaw across the wrap and retracts the camera boom before an obstacle', () => {
  const nearPositivePi = Math.PI - 0.02;
  const nearNegativePi = -Math.PI + 0.02;
  const midpoint = followCamera.interpolateAngle(nearPositivePi, nearNegativePi, 0.5);
  assert.ok(Math.abs(Math.abs(midpoint) - Math.PI) < 1e-12);

  assert.equal(followCamera.resolveBoomDistance(3.5, []), 3.5);
  assert.equal(followCamera.resolveBoomDistance(3.5, [2.4, 1.2, 1.8]), 1.04);
  assert.equal(followCamera.resolveBoomDistance(3.5, [0.1]), 0.02);
});

test('limits camera collision raycasts to sections intersecting the padded boom bounds', () => {
  const nearby = { id: 'nearby' };
  const boundary = { id: 'boundary' };
  const negative = { id: 'negative' };
  const far = { id: 'far' };
  const sections = {
    '0,0,0': nearby,
    '16,0,0': boundary,
    '-16,0,-16': negative,
    '64,0,64': far,
  };

  assert.deepEqual(
    followCamera.selectNearbySectionMeshes(sections, { x: 15.9, y: 8, z: 2 }, { x: 16.1, y: 8, z: 4 }, 0.2)
      .map((mesh) => (mesh as { id: string }).id)
      .sort(),
    ['boundary', 'nearby'],
  );
  assert.deepEqual(
    followCamera.selectNearbySectionMeshes(sections, { x: -0.1, y: 8, z: -0.1 }, { x: 0.1, y: 8, z: 0.1 }, 0.2)
      .map((mesh) => (mesh as { id: string }).id)
      .sort(),
    ['nearby', 'negative'],
  );
});

test('renders scripted village dialogue actors with the native villager model in Prismarine Viewer', () => {
  const prismarineRoot = dirname(require.resolve('prismarine-viewer'));
  const browserEntrySource = readFileSync(join(prismarineRoot, 'lib', 'index.js'), 'utf8');
  const worldViewSource = readFileSync(join(prismarineRoot, 'viewer', 'lib', 'worldView.js'), 'utf8');
  const entityRendererSource = readFileSync(join(prismarineRoot, 'viewer', 'lib', 'entities.js'), 'utf8');
  const villagerModels = JSON.parse(readFileSync(join(prismarineRoot, 'viewer', 'lib', 'entity', 'entities.json'), 'utf8'));
  const browserBundle = readFileSync(join(prismarineRoot, 'public', 'index.js'), 'utf8');

  assert.match(browserEntrySource, /const \{ OrbitControls \} = require\('three\/examples\/jsm\/controls\/OrbitControls'\)/);
  assert.match(browserEntrySource, /new OrbitControls\(viewer\.camera, renderer\.domElement\)/);
  assert.ok(browserBundle.includes('OrbitControls'));
  assert.doesNotMatch(browserBundle, /new THREE\.OrbitControls/);
  assert.match(worldViewSource, /\['Anna', 'James', 'Thomas'\]\.includes\(e\.username\) \? 'villager' : e\.name/);
  assert.equal((worldViewSource.match(/name: \['Anna', 'James', 'Thomas'\]\.includes\(e\.username\) \? 'villager' : e\.name/g) ?? []).length, 2);
  assert.match(entityRendererSource, /if \(\['Anna', 'James', 'Thomas'\]\.includes\(entity\.username\)\)/);
  assert.match(entityRendererSource, /const text = entity\.username/);
  assert.match(entityRendererSource, /sprite\.scale\.set\(\(canvas\.width \/ canvas\.height\) \* 0\.3, 0\.3, 1\)/);
  assert.match(entityRendererSource, /ctx\.fillStyle = '#ffffff'/);
  assert.doesNotMatch(entityRendererSource, /createCanvas\(500, 100\)/);
  assert.equal(villagerModels.villager.textures.default, 'textures/entity/villager/villager');
  assert.ok(browserBundle.includes('"default":"textures/entity/villager/villager"'));
});

test('production postinstall reuses verified assets or fails closed when webpack is omitted', () => {
  const scriptPath = join(dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'apply-prismarine-viewer-fix.cjs');
  const prismarineRoot = dirname(require.resolve('prismarine-viewer'));
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, BOSON_WEBPACK_BIN: join(prismarineRoot, '__webpack_not_installed__') },
  });

  if (result.status === 0) {
    assert.equal(result.stderr, '');
    return;
  }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot verify or build the Boson viewer patch: webpack is unavailable/);
});

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

test('normalizes camera help for clean upstream HTML without removing its script', () => {
  const cleanUpstream = '<html>\n  <body>\n    <script type="text/javascript" src="index.js"></script>\n  </body>\n</html>\n';
  const normalized = normalizeCameraHelpSource(cleanUpstream);
  assert.match(normalized, /Click the world to play · WASD move · mouse look · Esc releases controls/);
  assert.match(normalized, /<script type="text\/javascript" src="index\.js"><\/script>/);
  assert.equal(normalizeCameraHelpSource(normalized), normalized);

  const legacy = '<html>\n  <body>\n    <div class="camera-help" role="status">Drag to look · scroll to zoom · right-drag to pan</div>\n    <script src="index.js"></script>\n  </body>\n</html>\n';
  const patchedLegacy = normalizeCameraHelpSource(legacy);
  assert.match(patchedLegacy, /Click the world to play · WASD move · mouse look · Esc releases controls/);
  assert.match(patchedLegacy, /<script src="index\.js"><\/script>/);
  assert.equal(normalizeCameraHelpSource(patchedLegacy), patchedLegacy);
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
    const pttClient = await fetch(`http://127.0.0.1:${port}/boson-ptt.js`, { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(pttClient.status, 200);
    assert.match(await pttClient.text(), /from '\.\/village-vocabulary\.js'/);
    const vocabulary = await fetch(`http://127.0.0.1:${port}/village-vocabulary.js`, { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(vocabulary.status, 200);
    assert.match(await vocabulary.text(), /ask_about_known_topic/);
    const mixer = await fetch(`http://127.0.0.1:${port}/audio/spatial-voice-mixer.js`, { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(mixer.status, 200);
    const stream = await fetch(`http://127.0.0.1:${port}/boson-dialogue`, { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(stream.status, 200);
    activeReader = stream.body?.getReader();
    assert.ok(activeReader);
    await activeReader.read();
    const event = { type: 'village.dialogue', speakerId: 'mira', speakerName: 'Anna', line: 'Good morning.', position: { x: 0, y: 64, z: 0 }, timestamp: 123 };
    const response = await fetch(`http://127.0.0.1:${port}/boson-dialogue`, {
      method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify(event),
    });
    assert.equal(response.status, 202);
    const message = await activeReader.read();
    assert.match(new TextDecoder().decode(message.value), /event: dialogue[\s\S]*Anna/);
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

test('serves the opt-in native resident page and bundled assets without provider credentials', async () => {
  const probe = createServer();
  probe.listen(0);
  await new Promise<void>((resolve) => probe.once('listening', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const originalApiKey = process.env.BOSON_API_KEY;
  const originalEnvFile = process.env.BOSON_PTT_ENV_FILE;
  const originalIpcSocket = process.env.BOSON_VILLAGE_IPC_SOCKET;
  delete process.env.BOSON_API_KEY;
  delete process.env.BOSON_PTT_ENV_FILE;
  delete process.env.BOSON_VILLAGE_IPC_SOCKET;
  let server: Server | undefined;
  const stop = await startLoopbackViewer({}, port, (_bot, options) => {
    server = createServer((_request, response) => response.end('viewer'));
    server.listen(options.port, () => undefined);
  });
  try {
    const sameSite = { 'sec-fetch-site': 'same-origin' };
    const nativePage = await fetch(`http://127.0.0.1:${port}/?nativeResidentAudio=1`, { headers: sameSite });
    assert.equal(nativePage.status, 200);
    const nativeHtml = await nativePage.text();
    assert.match(nativeHtml, /boson-ptt-native\.js/);
    assert.match(nativeHtml, /boson-controls\.js/);
    assert.doesNotMatch(nativeHtml, /boson-audio\.js|boson-ptt\.js/);

    const normalPage = await fetch(`http://127.0.0.1:${port}/`, { headers: sameSite });
    const normalHtml = await normalPage.text();
    assert.match(normalHtml, /boson-audio\.js/);
    assert.match(normalHtml, /boson-ptt\.js/);
    assert.doesNotMatch(normalHtml, /boson-ptt-native\.js/);

    for (const path of [
      '/boson-ptt-native.js',
      '/audio/native-realtime-core.js',
      '/audio/native-resident-pcm-mixer.js',
      '/audio/spatial-voice-mixer.js',
      '/audio/native-response-playback.js',
    ]) {
      const asset = await fetch(`http://127.0.0.1:${port}${path}`, { headers: sameSite });
      assert.equal(asset.status, 200, path);
      assert.match(asset.headers.get('content-type') ?? '', /javascript/);
      assert.ok((await asset.text()).length > 0, path);
    }

    const status = await fetch(`http://127.0.0.1:${port}/boson-ptt/status`, { headers: sameSite });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).available, false);
  } finally {
    await stop();
    if (originalApiKey === undefined) delete process.env.BOSON_API_KEY;
    else process.env.BOSON_API_KEY = originalApiKey;
    if (originalEnvFile === undefined) delete process.env.BOSON_PTT_ENV_FILE;
    else process.env.BOSON_PTT_ENV_FILE = originalEnvFile;
    if (originalIpcSocket === undefined) delete process.env.BOSON_VILLAGE_IPC_SOCKET;
    else process.env.BOSON_VILLAGE_IPC_SOCKET = originalIpcSocket;
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
    const browserNavigation = await new Promise<{ statusCode?: number }>((resolve, reject) => {
      const request = httpGet(`http://127.0.0.1:${port}/`, {
        headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      }, (response) => { response.resume(); resolve(response); });
      request.once('error', reject);
    });
    assert.equal(browserNavigation.statusCode, 200);
    const browserPttStatus = await new Promise<{ statusCode?: number }>((resolve, reject) => {
      const request = httpGet(`http://127.0.0.1:${port}/boson-ptt/status`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      }, (response) => { response.resume(); resolve(response); });
      request.once('error', reject);
    });
    assert.equal(browserPttStatus.statusCode, 200);
    const originlessPttBegin = await new Promise<{ statusCode?: number }>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}/boson-ptt/begin`, {
        method: 'POST', headers: { 'sec-fetch-site': 'same-origin' },
      }, (response) => { response.resume(); resolve(response); });
      request.once('error', reject);
      request.end();
    });
    assert.equal(originlessPttBegin.statusCode, 403);
    const crossSiteApi = await fetch(`http://127.0.0.1:${port}/boson-ptt/status`, {
      headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    });
    assert.equal(crossSiteApi.status, 403);
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
