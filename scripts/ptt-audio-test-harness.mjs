import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createIpcServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPttServer, isPttModelResponse, isSameOriginPttRequest } from '../packages/minecraft/src/viewer-ptt-server.ts';
import { isVillageDialogue } from '../packages/minecraft/src/viewer-audio.js';
import { createHiggsTtsHandler, RESIDENT_VOICES, TTS_CHARACTER_USD } from '../packages/minecraft/src/audio/higgs-tts.js';
import { buildNativeResidentInstructions, equalLoafResidentFact } from '../packages/minecraft/src/native-resident-context.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_PATH = join(PROJECT_ROOT, 'boson-api-demo', 'ptt-audio-test.html');
const NATIVE_PAGE_PATH = join(PROJECT_ROOT, 'boson-api-demo', 'ptt-native-audio.html');
const STORY_PAGE_PATH = join(PROJECT_ROOT, 'boson-api-demo', 'native-story-audio.html');
const STORY_RESIDENTS = Object.freeze([
  Object.freeze({ id: 'mira', name: 'Anna', role: 'garden helper', goal: 'help the village and speak up for the value of garden work', voice: 'chloe', topics: ['garden', 'work', 'fairness'] }),
  Object.freeze({ id: 'tobin', name: 'James', role: 'map keeper', goal: 'keep village shares clear and easy to check', voice: 'oliver', topics: ['maps', 'households', 'fairness'] }),
  Object.freeze({ id: 'pip', name: 'Thomas', role: 'baker', goal: 'make sure every household has bread and welcome newcomers', voice: 'jake', topics: ['bread', 'households', 'welcome'] }),
]);
const MAX_TEST_TURNS = 2;
const MAX_HOLD_MS = 30_000;
const MAX_TTS_REQUESTS = 2;
const MAX_TTS_CHARACTERS = 96;
let mockRealtimeHarnessActive = false;

export const FIXED_RESIDENT = Object.freeze({
  id: 'mira',
  name: 'Anna',
  role: 'garden helper',
  goal: 'welcome visitors or help with ordinary garden work',
  locationId: 'isolated-audio-test',
  topics: Object.freeze(['general', 'garden']),
  facts: Object.freeze(['The garden is growing well today.', 'The east beds need watering.']),
  responseOptions: Object.freeze([
    Object.freeze({
      lineId: 'mira-greeting',
      summary: 'A warm authored greeting',
      allowedIntents: Object.freeze(['greet']),
      topics: Object.freeze(['general']),
    }),
    Object.freeze({
      lineId: 'mira-garden-help',
      summary: 'A simple public request for garden help',
      allowedIntents: Object.freeze(['ask_for_help']),
      topics: Object.freeze(['garden']),
    }),
  ]),
  relationship: 'unfamiliar',
});

export const FIXED_AUTHORED_LINE = Object.freeze({
  lineId: 'mira-greeting',
  text: 'Hello. The garden is growing well today.',
});
const AUTHORED_LINES = new Map([
  ['mira-greeting', FIXED_AUTHORED_LINE],
  ['mira-garden-help', Object.freeze({ lineId: 'mira-garden-help', text: 'Please water the east beds.' })],
]);

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  }).end(JSON.stringify(value));
}

function isLocalViewerRequest(request, origins, hosts) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  return typeof host === 'string' && hosts.has(host)
    && (!origin || origins.has(origin))
    && request.headers['sec-fetch-site'] !== 'cross-site';
}

function safeNativeNavigationDiagnostics(request, origins, hosts) {
  const enumValue = (value, allowed) => allowed.includes(value) ? value : 'other';
  const origin = request.headers.origin;
  const host = request.headers.host;
  return `host=${hosts.has(host) ? 'allowed' : 'other'}; origin=${!origin ? 'absent' : origins.has(origin) ? 'allowed' : 'other'}`
    + `; fetchSite=${enumValue(request.headers['sec-fetch-site'], ['none', 'same-origin', 'same-site', 'cross-site'])}`
    + `; mode=${enumValue(request.headers['sec-fetch-mode'], ['navigate', 'cors', 'no-cors', 'same-origin'])}`
    + `; dest=${enumValue(request.headers['sec-fetch-dest'], ['document', 'empty', 'script', 'worker', 'audio'])}`;
}

function sendIpcAck(socket, value) {
  socket.end(`${JSON.stringify(value)}\n`);
}

function createFixedFixtureIpc(socketPath, onComplete) {
  const server = createIpcServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > 8_192) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let command;
      try { command = JSON.parse(buffer.slice(0, newline)); } catch {
        sendIpcAck(socket, { version: 1, type: 'ptt.ack', phase: 'error', status: 'invalid' });
        return;
      }
      if (command?.type === 'ptt.begin' && typeof command.turnId === 'string') {
        sendIpcAck(socket, {
          version: 1,
          type: 'ptt.ack',
          phase: 'begin',
          turnId: command.turnId,
          status: 'ready',
          resident: FIXED_RESIDENT,
        });
        return;
      }
      if (command?.type === 'ptt.complete' && typeof command.turnId === 'string') {
        const selected = isPttModelResponse(command.response, FIXED_RESIDENT) ? command.response : null;
        onComplete(command.turnId, selected);
        sendIpcAck(socket, {
          version: 1,
          type: 'ptt.ack',
          phase: 'complete',
          turnId: command.turnId,
          status: selected ? 'accepted' : 'fallback',
        });
        return;
      }
      if (command?.type === 'ptt.cancel' && typeof command.turnId === 'string') {
        sendIpcAck(socket, {
          version: 1,
          type: 'ptt.ack',
          phase: 'cancel',
          turnId: command.turnId,
          status: 'cancelled',
        });
        return;
      }
      sendIpcAck(socket, { version: 1, type: 'ptt.ack', phase: 'error', status: 'unavailable' });
    });
  });
  server.listen(socketPath);
  return server;
}

function serverListening(server, port, host) {
  return new Promise((resolveListening, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolveListening(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function startPttAudioHarness({ port = 0, host = '127.0.0.1', providerEnabled = true, ttsFetcher = globalThis.fetch, realtimeFetcher = globalThis.fetch, mockRealtime = false } = {}) {
  if (host !== '127.0.0.1') {
    throw new TypeError('The PTT audio harness must bind to loopback');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('The PTT audio harness port is invalid');
  if (typeof providerEnabled !== 'boolean') throw new TypeError('The PTT audio provider flag is invalid');
  if (typeof ttsFetcher !== 'function') throw new TypeError('The PTT audio TTS transport is invalid');
  if (typeof realtimeFetcher !== 'function') throw new TypeError('The PTT audio Realtime transport is invalid');
  if (typeof mockRealtime !== 'boolean') throw new TypeError('The PTT audio Realtime mock flag is invalid');

  const previousSocketPath = process.env.BOSON_VILLAGE_IPC_SOCKET;
  const previousEnvironmentFile = process.env.BOSON_PTT_ENV_FILE;
  const previousApiKey = process.env.BOSON_API_KEY;
  const previousFetch = globalThis.fetch;
  const tempDirectory = await mkdtemp(join(tmpdir(), 'boson-ptt-audio-'));
  await chmod(tempDirectory, 0o700);
  if (mockRealtime && mockRealtimeHarnessActive) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw new Error('Only one mocked Realtime harness may run in this process');
  }
  if (mockRealtime) mockRealtimeHarnessActive = true;
  const socketPath = join(tempDirectory, 'fixture.sock');
  process.env.BOSON_VILLAGE_IPC_SOCKET = socketPath;
  if (providerEnabled && mockRealtime) process.env.BOSON_API_KEY = 'local-test-key';
  else if (providerEnabled) process.env.BOSON_PTT_ENV_FILE ??= join(PROJECT_ROOT, '.env');
  else {
    process.env.BOSON_API_KEY = '';
    process.env.BOSON_PTT_ENV_FILE = join(tempDirectory, 'provider-disabled.env');
  }

  let pttServer;
  let ttsServer;
  let ipcServer;
  let pageTemplate;
  let nativePageTemplate;
  let storyPageTemplate;
  let httpServer;
  let stopped = false;
  let realtimeTurnsUsed = 0;
  let lastTurn = null;
  const turnResults = [];
  let mockFetchUsers = 0;
  let mockOriginalFetch;
  let mockFetch;
  let activeNativeSession = null;
  let nativeSessionStartInFlight = false;
  const storySessions = new Map();
  const storySessionsByResident = new Map();
  const storyStartsInFlight = new Set();
  const dialogueClients = new Set();
  const dialogueByKey = new Map();

  const acquireMockFetch = () => {
    if (mockFetchUsers++ > 0) return;
    mockOriginalFetch = globalThis.fetch;
    mockFetch = (input, init) => String(input) === 'https://api.boson.ai/v1/realtime/client_secrets'
      ? realtimeFetcher(input, init)
      : Promise.reject(new Error('Network access is disabled in the mocked audio harness'));
    globalThis.fetch = mockFetch;
  };
  const releaseMockFetch = () => {
    if (mockFetchUsers === 0 || --mockFetchUsers > 0) return;
    if (globalThis.fetch === mockFetch) globalThis.fetch = mockOriginalFetch;
    mockOriginalFetch = undefined;
    mockFetch = undefined;
  };

  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    if (mockFetchUsers > 0) {
      mockFetchUsers = 1;
      releaseMockFetch();
    }
    pttServer?.close();
    ttsServer?.close();
    for (const client of dialogueClients) client.end();
    dialogueClients.clear();
    storySessions.clear();
    storySessionsByResident.clear();
    storyStartsInFlight.clear();
    await Promise.all([closeServer(httpServer), closeServer(ipcServer)]);
    await rm(tempDirectory, { recursive: true, force: true });
    if (previousSocketPath === undefined) delete process.env.BOSON_VILLAGE_IPC_SOCKET;
    else process.env.BOSON_VILLAGE_IPC_SOCKET = previousSocketPath;
    if (previousEnvironmentFile === undefined) delete process.env.BOSON_PTT_ENV_FILE;
    else process.env.BOSON_PTT_ENV_FILE = previousEnvironmentFile;
    if (previousApiKey === undefined) delete process.env.BOSON_API_KEY;
    else process.env.BOSON_API_KEY = previousApiKey;
    globalThis.fetch = previousFetch;
    if (mockRealtime) mockRealtimeHarnessActive = false;
  };

  const broadcast = (event) => {
    if (!isVillageDialogue(event) || !event.eventId || !event.lineId) return;
    const key = `${event.speakerId}:${event.eventId}`;
    dialogueByKey.set(key, event);
    while (dialogueByKey.size > 2) dialogueByKey.delete(dialogueByKey.keys().next().value);
    const message = `event: dialogue\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of dialogueClients) client.write(message);
  };

  const onComplete = (turnId, selected) => {
    lastTurn = {
      status: selected ? 'authored_response_selected' : 'authored_fallback',
      ...(selected ? { playerIntent: selected.playerIntent, topic: selected.topic, lineId: selected.lineId } : { lineId: FIXED_AUTHORED_LINE.lineId }),
    };
    if (turnResults.length < MAX_TEST_TURNS) {
      turnResults.push({ turnNumber: realtimeTurnsUsed, ...lastTurn });
    }
    const authoredLine = AUTHORED_LINES.get(lastTurn.lineId) ?? FIXED_AUTHORED_LINE;
    broadcast({
      type: 'village.dialogue',
      eventId: `audio-test-${turnId}`,
      lineId: authoredLine.lineId,
      speakerId: FIXED_RESIDENT.id,
      speakerName: FIXED_RESIDENT.name,
      line: authoredLine.text,
      position: { x: 0, y: 0, z: 0 },
      timestamp: Date.now(),
    });
  };

  const requestHandler = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const address = httpServer.address();
    const portNumber = typeof address === 'object' && address ? address.port : port;
    const viewerOrigins = new Set([`http://127.0.0.1:${portNumber}`, `http://localhost:${portNumber}`]);
    const allowedHosts = new Set([`127.0.0.1:${portNumber}`, `localhost:${portNumber}`]);

    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    const isTopLevelNavigation = request.method === 'GET' && request.url?.split('?')[0] === '/'
      && allowedHosts.has(request.headers.host)
      && request.headers['sec-fetch-mode'] === 'navigate'
      && request.headers['sec-fetch-dest'] === 'document'
      && !request.headers.origin;
    const isNativeTopLevelNavigation = request.method === 'GET' && pathname === '/native'
      && allowedHosts.has(request.headers.host)
      && request.headers['sec-fetch-mode'] === 'navigate'
      && request.headers['sec-fetch-dest'] === 'document'
      && !request.headers.origin;
    const isStoryTopLevelNavigation = request.method === 'GET' && pathname === '/native-story'
      && allowedHosts.has(request.headers.host)
      && request.headers['sec-fetch-mode'] === 'navigate'
      && request.headers['sec-fetch-dest'] === 'document'
      && !request.headers.origin;
    if (!isLocalViewerRequest(request, viewerOrigins, allowedHosts) && !isTopLevelNavigation && !isNativeTopLevelNavigation && !isStoryTopLevelNavigation) {
      const detail = (pathname === '/native' || pathname === '/native-story') && request.method === 'GET'
        ? ` Safe request metadata: ${safeNativeNavigationDiagnostics(request, viewerOrigins, allowedHosts)}.` : '';
      response.writeHead(403).end(`Loopback same-origin requests only.${detail}`);
      return;
    }

    if (request.method === 'GET' && pathname === '/') {
      const nonce = randomBytes(18).toString('base64url');
      response.setHeader('Content-Security-Policy', [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}'`,
        `style-src 'self' 'nonce-${nonce}'`,
        `connect-src 'self' wss://api.boson.ai`,
        "worker-src 'self'",
        "media-src 'self' blob:",
        "img-src 'self' data:",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '));
      response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(pageTemplate.replaceAll('__CSP_NONCE__', nonce));
      return;
    }

    if (request.method === 'GET' && pathname === '/native') {
      const nonce = randomBytes(18).toString('base64url');
      response.setHeader('Content-Security-Policy', [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}'`,
        `style-src 'self' 'nonce-${nonce}'`,
        `connect-src 'self' wss://api.boson.ai`,
        "worker-src 'self'",
        "media-src 'self' blob:",
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '));
      response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(nativePageTemplate.replaceAll('__CSP_NONCE__', nonce));
      return;
    }

    if (request.method === 'GET' && pathname === '/native-story') {
      const nonce = randomBytes(18).toString('base64url');
      response.setHeader('Content-Security-Policy', [
        "default-src 'none'", `script-src 'self' 'nonce-${nonce}'`, `style-src 'self' 'nonce-${nonce}'`,
        "connect-src 'self' wss://api.boson.ai", "worker-src 'self'", "media-src 'self' blob:",
        "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
      ].join('; '));
      response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(storyPageTemplate.replaceAll('__CSP_NONCE__', nonce));
      return;
    }

    if (pathname === '/native/story/residents' && request.method === 'GET') {
      if (!isLocalViewerRequest(request, viewerOrigins, allowedHosts)) { json(response, 403, { available: false }); return; }
      json(response, 200, { residents: STORY_RESIDENTS.map(({ id, name, role, voice }) => ({ residentId: id, name, role, voice })) });
      return;
    }

    if (pathname === '/native/story/session/start' && request.method === 'POST') {
      if (!isSameOriginPttRequest(request, viewerOrigins)) { json(response, 403, { available: false, error: 'Local same-origin native sessions only.' }); return; }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > 1_024) { json(response, 413, { available: false, error: 'Invalid resident session request.' }); return; }
      }
      let requested;
      try { requested = JSON.parse(body); } catch { requested = null; }
      const resident = STORY_RESIDENTS.find(({ id }) => id === requested?.residentId);
      if (!resident) { json(response, 400, { available: false, error: 'Choose a supported resident.' }); return; }
      const now = Math.floor(Date.now() / 1_000);
      const oldId = storySessionsByResident.get(resident.id);
      const oldSession = oldId ? storySessions.get(oldId) : null;
      if (oldSession && oldSession.leaseExpiresAt > now) {
        json(response, 409, { available: false, error: 'This resident conversation is already active in this tester.' }); return;
      }
      if (oldId) { storySessions.delete(oldId); storySessionsByResident.delete(resident.id); }
      if (storyStartsInFlight.has(resident.id)) { json(response, 409, { available: false, error: 'This resident conversation is starting.' }); return; }
      if (!providerEnabled || !process.env.BOSON_API_KEY?.trim()) { json(response, 503, { available: false, error: 'Native Boson Realtime is not configured.' }); return; }
      storyStartsInFlight.add(resident.id);
      try {
        const fetcher = mockRealtime ? realtimeFetcher : globalThis.fetch;
        const result = await fetcher('https://api.boson.ai/v1/realtime/client_secrets', {
          method: 'POST', headers: { authorization: `Bearer ${process.env.BOSON_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ expires_after: { seconds: 300 } }), signal: AbortSignal.timeout(8_000),
        });
        const payload = await result.json();
        if (!result.ok || !payload || typeof payload.value !== 'string' || !payload.value.startsWith('bai-eph-')
          || !Number.isSafeInteger(payload.expires_at) || payload.expires_at <= now) {
          json(response, 503, { available: false, error: 'Native Boson Realtime could not start.' }); return;
        }
        const residentSessionId = randomUUID();
        const sessionId = randomUUID();
        const leaseExpiresAt = Math.floor(Date.now() / 1_000) + 60;
        storySessions.set(sessionId, { sessionId, residentSessionId, residentId: resident.id, leaseExpiresAt });
        storySessionsByResident.set(resident.id, sessionId);
        const instructions = buildNativeResidentInstructions({
          id: resident.id, name: resident.name, role: resident.role, goal: resident.goal,
          locationId: 'isolated-equal-loaf-test', topics: resident.topics,
          facts: [equalLoafResidentFact(resident.id)], responseOptions: [], relationship: 'newcomer',
        });
        json(response, 200, { available: true, sessionId, residentSessionId, residentId: resident.id, name: resident.name,
          voice: resident.voice, instructions, clientSecret: payload.value, expiresAt: payload.expires_at });
      } catch {
        json(response, 503, { available: false, error: 'Native Boson Realtime could not start.' });
      } finally { storyStartsInFlight.delete(resident.id); }
      return;
    }

    if (pathname === '/native/story/session/heartbeat' && request.method === 'POST') {
      if (!isSameOriginPttRequest(request, viewerOrigins)) { json(response, 403, { active: false }); return; }
      const session = storySessions.get(url.searchParams.get('sessionId'));
      const now = Math.floor(Date.now() / 1_000);
      if (!session || session.leaseExpiresAt <= now) {
        if (session) { storySessions.delete(session.sessionId); storySessionsByResident.delete(session.residentId); }
        json(response, 404, { active: false }); return;
      }
      session.leaseExpiresAt = now + 60;
      json(response, 200, { active: true });
      return;
    }

    if (pathname === '/native/story/session/end' && request.method === 'POST') {
      if (!isSameOriginPttRequest(request, viewerOrigins)) { json(response, 403, { ended: false }); return; }
      const sessionId = url.searchParams.get('sessionId');
      const session = storySessions.get(sessionId);
      if (!session) { json(response, 404, { ended: false }); return; }
      storySessions.delete(sessionId);
      if (storySessionsByResident.get(session.residentId) === sessionId) storySessionsByResident.delete(session.residentId);
      json(response, 200, { ended: true });
      return;
    }

    if (pathname === '/native/session/start' && request.method === 'POST') {
      if (!isSameOriginPttRequest(request, viewerOrigins)) {
        json(response, 403, { available: false, error: 'Local same-origin native sessions only.' });
        return;
      }
      if (!providerEnabled || !process.env.BOSON_API_KEY?.trim()) {
        json(response, 503, { available: false, error: 'Native Boson Realtime is not configured.' });
        return;
      }
      if (activeNativeSession && activeNativeSession.leaseExpiresAt <= Math.floor(Date.now() / 1_000)) activeNativeSession = null;
      if (activeNativeSession || nativeSessionStartInFlight) {
        json(response, 409, { available: false, error: 'A resident session is already active.' });
        return;
      }
      const now = Math.floor(Date.now() / 1_000);
      nativeSessionStartInFlight = true;
      try {
        const fetcher = mockRealtime ? realtimeFetcher : globalThis.fetch;
        const result = await fetcher('https://api.boson.ai/v1/realtime/client_secrets', {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env.BOSON_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ expires_after: { seconds: 300 } }),
          signal: AbortSignal.timeout(8_000),
        });
        const payload = await result.json();
        if (!result.ok || !payload || typeof payload !== 'object'
          || typeof payload.value !== 'string' || !payload.value.startsWith('bai-eph-')
          || !Number.isSafeInteger(payload.expires_at) || payload.expires_at <= now) {
          json(response, 503, { available: false, error: 'Native Boson Realtime could not start.' });
          return;
        }
        const sessionId = randomUUID();
        activeNativeSession = { sessionId, expiresAt: payload.expires_at, leaseExpiresAt: Math.floor(Date.now() / 1_000) + 60 };
        json(response, 200, { available: true, sessionId, clientSecret: payload.value, expiresAt: payload.expires_at });
      } catch {
        json(response, 503, { available: false, error: 'Native Boson Realtime could not start.' });
      } finally {
        nativeSessionStartInFlight = false;
      }
      return;
    }

    if (pathname === '/native/session/heartbeat' && request.method === 'POST') {
      if (!isSameOriginPttRequest(request, viewerOrigins)) {
        json(response, 403, { active: false });
        return;
      }
      const sessionId = url.searchParams.get('sessionId');
      const now = Math.floor(Date.now() / 1_000);
      if (activeNativeSession && activeNativeSession.leaseExpiresAt <= now) activeNativeSession = null;
      if (!activeNativeSession || activeNativeSession.sessionId !== sessionId) {
        json(response, 404, { active: false });
        return;
      }
      activeNativeSession.leaseExpiresAt = now + 60;
      json(response, 200, { active: true });
      return;
    }

    if (pathname === '/native/session/end' && request.method === 'POST') {
      if (!isSameOriginPttRequest(request, viewerOrigins)) {
        json(response, 403, { ended: false });
        return;
      }
      const sessionId = url.searchParams.get('sessionId');
      if (!activeNativeSession || activeNativeSession.sessionId !== sessionId) {
        json(response, 404, { ended: false });
        return;
      }
      activeNativeSession = null;
      json(response, 200, { ended: true });
      return;
    }

    const assets = new Map([
      ['/boson-ptt.js', new URL('../packages/minecraft/src/viewer-ptt.js', import.meta.url)],
      ['/village-vocabulary.js', new URL('../packages/minecraft/src/village-vocabulary.js', import.meta.url)],
      ['/boson-ptt-worklet.js', new URL('../packages/minecraft/src/viewer-ptt-worklet.js', import.meta.url)],
      ['/boson-audio.js', new URL('../packages/minecraft/src/viewer-audio.js', import.meta.url)],
      ['/ptt-audio-test-view.js', new URL('../boson-api-demo/ptt-audio-test-view.js', import.meta.url)],
      ['/ptt-native-audio.js', new URL('../boson-api-demo/ptt-native-audio.js', import.meta.url)],
      ['/native-story-audio.js', new URL('../boson-api-demo/native-story-audio.js', import.meta.url)],
      ['/native-response-playback.js', new URL('../boson-api-demo/native-response-playback.js', import.meta.url)],
      ['/audio/spatial-voice-mixer.js', new URL('../packages/minecraft/src/audio/spatial-voice-mixer.js', import.meta.url)],
    ]);
    if (request.method === 'GET' && assets.has(pathname)) {
      const bytes = await readFile(assets.get(pathname));
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(bytes);
      return;
    }

    if (request.method === 'GET' && pathname === '/harness/status') {
      const ttsUsage = ttsServer.getUsage();
      json(response, 200, {
        fixture: { speakerId: FIXED_RESIDENT.id, speakerName: FIXED_RESIDENT.name, lineId: FIXED_AUTHORED_LINE.lineId },
        limits: {
          realtimeTurns: MAX_TEST_TURNS,
          maxHoldMs: MAX_HOLD_MS,
          responseTokens: 160,
          ttsRequests: MAX_TTS_REQUESTS,
          ttsCharacters: MAX_TTS_CHARACTERS,
          estimatedTtsUsdMax: Number((MAX_TTS_CHARACTERS * TTS_CHARACTER_USD).toFixed(6)),
        },
        usage: {
          realtimeTurns: realtimeTurnsUsed,
          lastTurn,
          turnResults: turnResults.slice(0, MAX_TEST_TURNS),
          tts: {
            requests: ttsUsage.requests,
            characters: ttsUsage.characters,
            estimatedUsd: ttsUsage.estimatedUsd,
            succeededRequests: ttsUsage.succeededRequests,
            failedRequests: ttsUsage.failedRequests,
            outcomeUnknownRequests: ttsUsage.outcomeUnknownRequests,
            actualProviderUsage: null,
          },
        },
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/boson-dialogue') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.write(': connected\n\n');
      dialogueClients.add(response);
      response.once('close', () => dialogueClients.delete(response));
      return;
    }

    if (pathname === '/boson-tts') {
      if (!isSameOriginPttRequest(request, viewerOrigins)) {
        response.writeHead(403).end('Same-origin audio test requests only.');
        return;
      }
      await ttsServer.handleRequest(request, response);
      return;
    }

    if (pathname === '/boson-ptt/begin' && request.method === 'POST') {
      if (realtimeTurnsUsed >= MAX_TEST_TURNS) {
        json(response, 429, { available: false, error: 'This isolated test allows two Realtime turns.' });
        return;
      }
      realtimeTurnsUsed += 1;
    }
    if (mockRealtime && pathname === '/boson-ptt/begin') {
      let fetchRestored = false;
      const restoreFetch = () => {
        if (fetchRestored) return;
        fetchRestored = true;
        releaseMockFetch();
      };
      acquireMockFetch();
      response.once('finish', restoreFetch);
      response.once('close', restoreFetch);
      response.once('error', restoreFetch);
      if (pttServer.handleRequest(request, response)) return;
      restoreFetch();
    }
    if (pttServer.handleRequest(request, response)) return;
    response.writeHead(404).end('Not found.');
  };

  try {
    pageTemplate = await readFile(PAGE_PATH, 'utf8');
    nativePageTemplate = await readFile(NATIVE_PAGE_PATH, 'utf8');
    storyPageTemplate = await readFile(STORY_PAGE_PATH, 'utf8');
    ipcServer = createFixedFixtureIpc(socketPath, onComplete);
    await new Promise((resolveListen, rejectListen) => {
      ipcServer.once('listening', resolveListen);
      ipcServer.once('error', rejectListen);
    });
    httpServer = createServer((request, response) => {
      void requestHandler(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'Cache-Control': 'no-store' });
        response.end('Local audio test request failed.');
      });
    });
    const address = await serverListening(httpServer, port, host);
    const portNumber = address.port;
    pttServer = createPttServer(portNumber);
    const viewerOrigins = new Set([`http://127.0.0.1:${portNumber}`, `http://localhost:${portNumber}`]);
    ttsServer = createHiggsTtsHandler({
      resolveUtterance: (eventId, speakerId) => {
        const event = dialogueByKey.get(`${speakerId}:${eventId}`);
        if (!event || speakerId !== FIXED_RESIDENT.id) return null;
        const line = AUTHORED_LINES.get(event.lineId);
        if (!line || event.lineId !== line.lineId) return null;
        return {
          lineId: line.lineId,
          text: line.text,
          voice: RESIDENT_VOICES[FIXED_RESIDENT.id],
        };
      },
      isAllowedRequest: (request) => isSameOriginPttRequest(request, viewerOrigins),
      fetcher: ttsFetcher,
      maxCharacters: MAX_TTS_CHARACTERS,
      maxRequests: MAX_TTS_REQUESTS,
      maxLookupRequests: MAX_TTS_REQUESTS,
      maxAudioBytes: 1_000_000,
      maxAudioCacheBytes: 1_000_000,
      maxDurationSeconds: 15,
      maxEventJobs: 1,
    });
    if (!providerEnabled) {
      if (previousApiKey === undefined) delete process.env.BOSON_API_KEY;
      else process.env.BOSON_API_KEY = previousApiKey;
    }
    return {
      url: `http://127.0.0.1:${portNumber}/`,
      host: address.address,
      port: portNumber,
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  startPttAudioHarness().then((harness) => {
    console.log(`Isolated Boson audio test ready at ${harness.url}`);
    console.log('No microphone or provider request occurs until you hold the PTT button. Press Ctrl+C to stop.');
    const stop = () => { void harness.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(() => {
    console.error('Isolated Boson audio test could not start.');
    process.exitCode = 1;
  });
}
