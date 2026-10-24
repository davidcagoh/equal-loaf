import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createIpcServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPttServer, isPttBeginAck, isPttModelResponse, isSameOriginPttRequest } from './viewer-ptt-server.ts';
import {
  createVillageCognitionState,
  getResidentKnowledgeContext,
  reduceVillageObservation,
  resolvePttResidentIntent,
  selectResidentIntent,
} from './village-cognition.ts';

test('PTT model output must use a canonical intent, topic, and compatible resident authored line', () => {
  const turn = { responseOptions: [
    { lineId: 'mira-greeting', summary: 'A greeting', allowedIntents: ['greet'], topics: ['general'] },
    { lineId: 'mira-garden-reply', summary: 'A garden reply', allowedIntents: ['ask_about_known_topic'], topics: ['garden'] },
  ] };
  assert.equal(isPttModelResponse({ playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' }, turn), true);
  assert.equal(isPttModelResponse({ playerIntent: 'greeting', topic: 'general', lineId: 'mira-greeting' }, turn), false);
  assert.equal(isPttModelResponse({ playerIntent: 'greet', topic: 'garden', lineId: 'mira-greeting' }, turn), false);
  assert.equal(isPttModelResponse({ playerIntent: 'ask_about_known_topic', topic: 'garden', lineId: 'mira-greeting' }, turn), false);
});

test('originless same-origin browser status GET is allowed while mutations remain origin-bound', () => {
  const origins = new Set(['http://127.0.0.1:3000', 'http://localhost:3000']);
  assert.equal(isSameOriginPttRequest({
    method: 'GET', url: '/boson-ptt/status', headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'same-origin' },
  } as unknown as IncomingMessage, origins), true);
  assert.equal(isSameOriginPttRequest({
    method: 'POST', url: '/boson-ptt/begin', headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'same-origin' },
  } as unknown as IncomingMessage, origins), false);
  assert.equal(isSameOriginPttRequest({
    method: 'GET', url: '/boson-ptt/status', headers: { host: 'attacker.example', 'sec-fetch-site': 'same-origin' },
  } as unknown as IncomingMessage, origins), false);
  assert.equal(isSameOriginPttRequest({
    method: 'GET', url: '/boson-ptt/status', headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' },
  } as unknown as IncomingMessage, origins), false);
});

test('validated begin context and model response select the same locally authored resident beat', () => {
  const state = createVillageCognitionState();
  const knowledge = getResidentKnowledgeContext(state, 'mira');
  const responseOptions = knowledge.responseOptions.map((option) => ({ ...option }));
  const ack = {
    version: 1, type: 'ptt.ack', phase: 'begin', turnId: 'turn-12345678', status: 'ready',
    resident: {
      id: 'mira', name: 'Mira', role: 'gardener', goal: knowledge.goal, locationId: 'west-garden',
      topics: [...knowledge.topics], facts: [...knowledge.facts], responseOptions,
      relationship: knowledge.relationship,
    },
  };
  assert.equal(isPttBeginAck(ack, 'turn-12345678'), true);
  const option = responseOptions.find(({ lineId }) => lineId === 'mira-guarded-garden-reply');
  assert.ok(option);
  const modelPayload = { playerIntent: 'greet', topic: 'general', lineId: option.lineId };
  const turn = { responseOptions };
  assert.equal(isPttModelResponse(modelPayload, turn), true);
  const intentContext = { residentId: 'mira', playerIntent: modelPayload.playerIntent, topic: modelPayload.topic, locationId: 'west-garden', tick: 1 } as const;
  const intent = selectResidentIntent(state, intentContext, 1, modelPayload);
  assert.equal(intent?.speech.kind, 'authored_line');
  assert.equal(intent?.speech.kind === 'authored_line' ? intent.speech.lineId : null, option.lineId);
});

test('HTTP begin and complete carry a safe choice over UDS and resolve private story locally without provider traffic', async () => {
  const originalKey = process.env.BOSON_API_KEY;
  const originalPttEnvFile = process.env.BOSON_PTT_ENV_FILE;
  const originalSocketPath = process.env.BOSON_VILLAGE_IPC_SOCKET;
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'boson-ptt-test-'));
  const socketPath = join(directory, 'village.sock');
  delete process.env.BOSON_PTT_ENV_FILE;
  process.env.BOSON_API_KEY = 'synthetic-test-key';
  process.env.BOSON_VILLAGE_IPC_SOCKET = socketPath;
  let providerCalls = 0;
  const ipcCommands: Array<{ type: string; response?: unknown }> = [];
  let selectedLocalLineId: string | undefined;
  let state = createVillageCognitionState();
  state = reduceVillageObservation(state, { type: 'player.behavior', eventId: 'fixture-trust-1', tick: 1, recipientIds: ['mira'], behavior: 'respectful_exchange' });
  state = reduceVillageObservation(state, { type: 'player.behavior', eventId: 'fixture-trust-2', tick: 2, recipientIds: ['mira'], behavior: 'respectful_exchange' });
  const knowledge = getResidentKnowledgeContext(state, 'mira');
  assert.equal(knowledge.factIds.includes('mira-sighting'), false);
  assert.equal(knowledge.responseOptions.some(({ lineId }) => lineId === 'mira-sighting-disclosure'), false);
  globalThis.fetch = (async () => {
    providerCalls += 1;
    return { ok: true, json: async () => ({ value: 'bai-eph-test', expires_at: Math.floor(Date.now() / 1_000) + 60 }) } as Response;
  }) as typeof fetch;

  const resident = {
    id: 'mira', name: 'Mira', role: 'gardener', goal: knowledge.goal, locationId: 'west-garden',
    topics: [...knowledge.topics], facts: [...knowledge.facts], relationship: knowledge.relationship,
    responseOptions: knowledge.responseOptions.map((option) => ({ ...option })),
  };
  const ipcServer = createIpcServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const command = JSON.parse(buffer.slice(0, newline)) as { type: string; turnId: string; response?: unknown };
      ipcCommands.push({ type: command.type, ...(command.response ? { response: command.response } : {}) });
      if (command.type === 'ptt.complete') {
        const resolved = resolvePttResidentIntent(state, {
          residentId: resident.id, locationId: resident.locationId, tick: 3,
        }, 7, command.response);
        selectedLocalLineId = resolved?.intent.speech.kind === 'authored_line' ? resolved.intent.speech.lineId : undefined;
        socket.end(`${JSON.stringify({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId, status: resolved ? 'accepted' : 'rejected' })}\n`);
        return;
      }
      const ack = command.type === 'ptt.begin'
        ? { version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId, status: 'ready', resident }
        : { version: 1, type: 'ptt.ack', phase: 'cancel', turnId: command.turnId, status: 'cancelled' };
      socket.end(`${JSON.stringify(ack)}\n`);
    });
  });
  const httpServer = createHttpServer();
  let ptt: ReturnType<typeof createPttServer> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      ipcServer.once('error', reject);
      ipcServer.listen(socketPath, resolve);
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    ptt = createPttServer(port);
    httpServer.on('request', (request, response) => {
      if (!ptt?.handleRequest(request, response)) response.writeHead(404).end();
    });

    const origin = `http://127.0.0.1:${port}`;
    const response = await originalFetch(`${origin}/boson-ptt/begin`, {
      method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    });
    const setup = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.deepEqual(setup.allowedLineIds, [
      'mira-guarded-garden-reply',
      'mira-garden-help-reply',
      'mira-routine-greeting',
    ]);
    assert.equal(setup.available, true);
    assert.equal(JSON.stringify(setup).includes('mira-sighting'), false);
    assert.equal(JSON.stringify(setup).includes('mira-sighting-disclosure'), false);
    assert.equal(providerCalls, 1);

    const completed = await originalFetch(`${origin}/boson-ptt/complete`, {
      method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: setup.turnId, response: {
        playerIntent: 'ask_about_known_topic', topic: 'garden', lineId: 'mira-guarded-garden-reply',
      } }),
    });
    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), { accepted: true, status: 'accepted' });
    assert.deepEqual(ipcCommands.map(({ type }) => type), ['ptt.begin', 'ptt.complete']);
    assert.equal(selectedLocalLineId, 'mira-sighting-disclosure');
    assert.equal(providerCalls, 1);
  } finally {
    ptt?.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => ipcServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.BOSON_API_KEY;
    else process.env.BOSON_API_KEY = originalKey;
    if (originalPttEnvFile === undefined) delete process.env.BOSON_PTT_ENV_FILE;
    else process.env.BOSON_PTT_ENV_FILE = originalPttEnvFile;
    if (originalSocketPath === undefined) delete process.env.BOSON_VILLAGE_IPC_SOCKET;
    else process.env.BOSON_VILLAGE_IPC_SOCKET = originalSocketPath;
    globalThis.fetch = originalFetch;
  }
});
