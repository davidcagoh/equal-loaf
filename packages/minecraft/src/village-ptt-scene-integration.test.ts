import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createIpcServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPttServer } from './viewer-ptt-server.ts';
import { createVillageCognitionState, getResidentKnowledgeContext, reduceVillageObservation } from './village-cognition.ts';
import { createEqualLoafState } from './village-short-scene.ts';
import { completeEqualLoafPttTurn, resolveEqualLoafPttTurn } from './village-ptt-scene-integration.ts';
import { getResidentsWithinHearingRadius } from './village-encounters.ts';

test('PTT HTTP and IPC use resident-scoped scene semantics and emit only the in-range attributed event', async () => {
  const originalKey = process.env.BOSON_API_KEY;
  const originalEnvFile = process.env.BOSON_PTT_ENV_FILE;
  const originalSocketPath = process.env.BOSON_VILLAGE_IPC_SOCKET;
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'boson-equal-loaf-'));
  const socketPath = join(directory, 'village.sock');
  process.env.BOSON_API_KEY = 'synthetic-test-key';
  delete process.env.BOSON_PTT_ENV_FILE;
  process.env.BOSON_VILLAGE_IPC_SOCKET = socketPath;
  let providerCalls = 0;
  let state = createVillageCognitionState();
  let sceneState = createEqualLoafState();
  const dialogueEvents: Array<Record<string, unknown>> = [];
  const appliedActions: string[] = [];
  const knowledge = getResidentKnowledgeContext(state, 'pip');
  const responseOptions = knowledge.responseOptions.map((option) => ({ ...option }));
  globalThis.fetch = (async () => {
    providerCalls += 1;
    return { ok: true, json: async () => ({ value: 'bai-eph-test', expires_at: Math.floor(Date.now() / 1_000) + 60 }) } as Response;
  }) as typeof fetch;

  const ipcServer = createIpcServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const command = JSON.parse(buffer.slice(0, newline)) as { turnId: string; type: string; response?: { playerIntent: 'greet'; topic: 'general'; lineId: string } };
      if (command.type === 'ptt.begin') {
        socket.end(`${JSON.stringify({
          version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId, status: 'ready',
          resident: {
            id: 'pip', name: 'Thomas', role: 'baker', goal: knowledge.goal, locationId: 'bakery-hearth',
            topics: [...knowledge.topics], facts: [...knowledge.facts], relationship: knowledge.relationship, responseOptions,
          },
        })}\n`);
        return;
      }
      assert.equal(command.type, 'ptt.complete');
      const explorerPosition = { x: 4, y: 69, z: 8 };
      const speakerPosition = { x: 4, y: 69, z: 4 };
      const residents = [
        { residentId: 'mira', name: 'Anna', locationId: 'west-garden', position: { x: 10, y: 69, z: 4 } },
        { residentId: 'tobin', name: 'James', locationId: 'map-board', position: { x: 16.1, y: 69, z: 4 } },
        { residentId: 'pip', name: 'Thomas', locationId: 'bakery-hearth', position: speakerPosition },
      ];
      state = reduceVillageObservation(state, {
        type: 'player.intent', eventId: command.turnId, tick: 100,
        recipientIds: getResidentsWithinHearingRadius(explorerPosition, residents), intent: 'greet', topic: 'general',
      });
      const heardResidentIds = getResidentsWithinHearingRadius(speakerPosition, residents);
      const result = completeEqualLoafPttTurn({
        state, sceneState, turnId: command.turnId, residentId: 'pip', locationId: 'bakery-hearth',
        tick: 100, semanticResponse: command.response!, position: speakerPosition, explorerPosition,
        residentName: 'Thomas', heardResidentIds,
        applyAction: (intent) => { appliedActions.push(`${intent.residentId}:${intent.action.kind}`); },
        emitDialogue: (event) => { dialogueEvents.push(event as unknown as Record<string, unknown>); return event.eventId ?? null; },
      });
      assert.equal(result.status, 'accepted', 'the selected safe scene line must resolve locally');
      state = result.state;
      sceneState = result.sceneState;
      socket.end(`${JSON.stringify({ version: 1, type: 'ptt.ack', phase: 'complete', turnId: command.turnId,
        status: 'accepted', residentId: 'pip', speakerName: 'Thomas', lineId: result.lineId, eventId: result.eventId })}\n`);
    });
  });
  const httpServer = createHttpServer();
  let ptt: ReturnType<typeof createPttServer> | undefined;
  httpServer.on('request', (request, response) => { if (!ptt?.handleRequest(request, response)) response.writeHead(404).end(); });

  try {
    await new Promise<void>((resolve, reject) => { ipcServer.once('error', reject); ipcServer.listen(socketPath, resolve); });
    process.env.BOSON_VILLAGE_IPC_SOCKET = socketPath;
    await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
    const address = httpServer.address();
    assert.ok(address && typeof address !== 'string');
    ptt = createPttServer(address.port);
    const origin = `http://127.0.0.1:${address.port}`;
    const begin = await originalFetch(`${origin}/boson-ptt/begin`, {
      method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    });
    const setup = await begin.json() as { turnId: string; allowedLineIds: string[] };
    assert.equal(begin.status, 200);
    assert.ok(setup.allowedLineIds.includes('equal-loaf.thomas.welcome'));
    const completion = await originalFetch(`${origin}/boson-ptt/complete`, {
      method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: setup.turnId, response: { playerIntent: 'greet', topic: 'general', lineId: 'equal-loaf.thomas.welcome' } }),
    });
    assert.equal(completion.status, 200);
    assert.equal(providerCalls, 1, 'only the stubbed ephemeral-secret fetch occurs');
    assert.equal(sceneState.started, true);
    assert.deepEqual(appliedActions, ['pip:look_at_player']);
    assert.ok(state.residents.pip?.knownFactIds.includes('equal-loaf-thomas-claim'));
    assert.equal(state.residents.mira?.heardClaims.some((claim) => claim.claimedFactId === 'equal-loaf-thomas-claim'), true);
    assert.equal(state.residents.tobin?.heardClaims.some((claim) => claim.claimedFactId === 'equal-loaf-thomas-claim'), false,
      'a resident beyond the 12-block hearing radius must not receive the scene claim');
    assert.equal(dialogueEvents.length, 1);
    assert.equal(dialogueEvents[0]?.lineId, 'equal-loaf.thomas.welcome');
    assert.equal(dialogueEvents[0]?.line, 'Welcome. I set aside one loaf for every household. It is a small thing, but a shared table should start with everyone.');
    assert.equal('playerRealization' in (dialogueEvents[0] ?? {}), false);
  } finally {
    ptt?.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => ipcServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.BOSON_API_KEY; else process.env.BOSON_API_KEY = originalKey;
    if (originalEnvFile === undefined) delete process.env.BOSON_PTT_ENV_FILE; else process.env.BOSON_PTT_ENV_FILE = originalEnvFile;
    if (originalSocketPath === undefined) delete process.env.BOSON_VILLAGE_IPC_SOCKET; else process.env.BOSON_VILLAGE_IPC_SOCKET = originalSocketPath;
    globalThis.fetch = originalFetch;
  }
});

test('scene completion rechecks live PTT range before action, event, or state commit', () => {
  const state = createVillageCognitionState();
  const sceneState = createEqualLoafState();
  let actions = 0;
  let events = 0;
  const result = completeEqualLoafPttTurn({
    state, sceneState, turnId: 'moved-away-12345678', residentId: 'pip', residentName: 'Thomas',
    locationId: 'bakery-hearth', tick: 100,
    semanticResponse: { playerIntent: 'greet', topic: 'general', lineId: 'equal-loaf.thomas.welcome' },
    explorerPosition: { x: 0, y: 69, z: 0 }, position: { x: 8.1, y: 69, z: 0 }, heardResidentIds: [],
    applyAction: () => { actions += 1; },
    emitDialogue: () => { events += 1; return 'unexpected'; },
  });
  assert.equal(result.status, 'expired');
  assert.equal(result.state, state);
  assert.equal(result.sceneState, sceneState);
  assert.equal(actions, 0);
  assert.equal(events, 0);
});

test('each resident receives only their own scene response IDs and no player realization in context', () => {
  const state = createVillageCognitionState();
  const ids = (residentId: 'mira' | 'tobin' | 'pip') => getResidentKnowledgeContext(state, residentId).responseOptions.map(({ lineId }) => lineId);
  assert.ok(ids('pip').includes('equal-loaf.thomas.welcome'));
  assert.ok(ids('pip').includes('equal-loaf.thomas.ordinary-close'));
  assert.deepEqual(ids('tobin').filter((id) => id.startsWith('equal-loaf.')), ['equal-loaf.james.household-map']);
  assert.deepEqual(ids('mira').filter((id) => id.startsWith('equal-loaf.')), ['equal-loaf.anna.garden-workers']);
  for (const residentId of ['mira', 'tobin', 'pip'] as const) {
    const knowledge = getResidentKnowledgeContext(state, residentId);
    assert.equal(knowledge.factIds.some((factId) => String(factId) === 'equal-loaf-inclusion'), false);
    assert.equal(knowledge.facts.some((fact) => /outside that count/i.test(fact)), false);
  }
});

test('player-only realization never becomes Thomas dialogue or another resident fact', () => {
  let state = createVillageCognitionState();
  let sceneState = createEqualLoafState();
  const steps = [
    { residentId: 'tobin' as const, playerIntent: 'ask_about_known_topic' as const, topic: 'route' as const, lineId: 'equal-loaf.james.household-map' },
    { residentId: 'mira' as const, playerIntent: 'ask_about_known_topic' as const, topic: 'garden' as const, lineId: 'equal-loaf.anna.garden-workers' },
  ];
  for (const [index, step] of steps.entries()) {
    const result = resolveEqualLoafPttTurn({
      state, sceneState, turnId: `account-${index}`, residentId: step.residentId, locationId: 'market-well', tick: index + 1,
      semanticResponse: { playerIntent: step.playerIntent, topic: step.topic, lineId: step.lineId },
      position: { x: index, y: 69, z: 4 }, residentName: step.residentId === 'mira' ? 'Anna' : 'James', heardResidentIds: [],
    });
    assert.ok(result);
    state = result.state;
    sceneState = result.sceneState;
  }
  const close = resolveEqualLoafPttTurn({
    state, sceneState, turnId: 'account-close', residentId: 'pip', locationId: 'bakery-hearth', tick: 3,
    semanticResponse: { playerIntent: 'ask_for_help', topic: 'bakery', lineId: 'equal-loaf.thomas.ordinary-close' },
    position: { x: 4, y: 69, z: 4 }, residentName: 'Thomas', heardResidentIds: ['mira', 'tobin', 'pip'],
  });
  assert.ok(close);
  assert.match(close.playerRealization?.text ?? '', /gardeners.*outside that count/i);
  assert.ok(state.residents.mira?.knownFactIds.includes('equal-loaf-garden-workers'));
  assert.equal(state.residents.pip?.knownFactIds.includes('equal-loaf-garden-workers'), false);
  assert.equal(close.dialogueEvent.line, 'I will set the loaf on the shared table. Stay a while if you like; there is room for another conversation.');
  assert.equal(close.dialogueEvent.line.includes('outside that count'), false);
  assert.equal(close.dialogueEvent.lineId, 'equal-loaf.thomas.ordinary-close');
  assert.equal(close.state.residents.pip?.knownFactIds.includes('equal-loaf-inclusion'), false);
});
