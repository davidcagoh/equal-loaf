import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createIpcServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPttServer, isNativeBeginRequest, isNativePlayerSpeechPayload } from './viewer-ptt-server.ts';
import { buildNativeResidentInstructions, equalLoafResidentFact } from './native-resident-context.ts';

const baseResident = {
  id: 'pip', name: 'Thomas', role: 'baker', goal: 'welcome visitors', locationId: 'bakery-hearth',
  topics: ['general', 'bakery'], facts: ['Thomas set aside one loaf for every household.'],
  responseOptions: [{ lineId: 'equal-loaf.thomas.welcome', summary: 'Welcome the newcomer.', allowedIntents: ['greet'], topics: ['general'] }],
  relationship: 'unfamiliar',
  recentHeardSpeech: [{ eventId: 'heard-1', speakerId: 'mira', speakerName: 'Anna', text: 'The garden workers brought vegetables.', tick: 1234 }],
};
const annaResident = {
  ...baseResident,
  id: 'mira', name: 'Anna', role: 'gardener', goal: 'protect the seedlings', locationId: 'west-garden',
  facts: ['Garden workers bring vegetables and asked you not to make them a public example.'],
  responseOptions: [{ lineId: 'equal-loaf.anna.garden-workers', summary: 'Explain the garden workers’ contribution.', allowedIntents: ['ask_about_known_topic'], topics: ['garden'] }],
  recentHeardSpeech: [],
};

test('native begin validates known resident sessions and prompts with attributed unverified speech', () => {
  assert.equal(isNativeBeginRequest({ knownResidentSessionIds: [] }), true);
  assert.equal(isNativeBeginRequest({ knownResidentSessionIds: ['session-a', 'session-a'] }), false);
  assert.equal(isNativeBeginRequest({ knownResidentSessionIds: ['bad id'] }), false);
  const prompt = buildNativeResidentInstructions(baseResident);
  assert.match(prompt, /Anna said: “The garden workers brought vegetables\.”/);
  assert.match(prompt, /attributed, unverified; not established truth/);
  assert.match(prompt, /Follow the person and conversation wherever they go, including tangents/);
  assert.match(prompt, /try to persuade/);
  assert.match(prompt, /beliefs, intentions, and promises can change through conversation/);
  assert.match(prompt, /dialogue alone does not alter game state or carry out an action/);
  assert.doesNotMatch(prompt, /equal-loaf-inclusion/);
  assert.doesNotMatch(prompt, /Eligible scene exchanges|There is no eligible special scene exchange/);
  assert.doesNotMatch(prompt, /Speak naturally and briefly/);
  assert.doesNotMatch(prompt, /Do not invent policies/);
  assert.doesNotMatch(prompt, /lineId/);
});

test('player input final accepts only a bounded provider item and server-bound turn fields', () => {
  const payload = { turnId: 'turn_12345678', residentSessionId: 'resident_session', itemId: 'item_input_1', transcript: 'Please water the seedlings.' };
  assert.equal(isNativePlayerSpeechPayload(payload), true);
  assert.equal(isNativePlayerSpeechPayload({ ...payload, speakerId: 'pip' }), false);
  assert.equal(isNativePlayerSpeechPayload({ ...payload, position: { x: 0, y: 64, z: 0 } }), false);
  assert.equal(isNativePlayerSpeechPayload({ ...payload, transcript: 'x'.repeat(1_001) }), false);
});

test('Equal Loaf native facts stay asymmetric across Thomas, James, and Anna', () => {
  const facts = {
    pip: equalLoafResidentFact('pip'),
    tobin: equalLoafResidentFact('tobin'),
    mira: equalLoafResidentFact('mira'),
  };
  assert.match(String(facts.pip), /one loaf for every household/);
  assert.match(String(facts.tobin), /map count gives one share/);
  assert.match(String(facts.mira), /garden workers tend the beds/);
  assert.equal(facts.pip?.includes('garden workers'), false);
  assert.equal(facts.tobin?.includes('garden workers'), false);
  assert.equal(facts.mira?.includes('map count'), false);
  assert.equal(equalLoafResidentFact('unknown'), undefined);
});

test('native voice turns bind resident sessions, issue credentials once, and forward only correlated speech events', async () => {
  const originalKey = process.env.BOSON_API_KEY;
  const originalEnvFile = process.env.BOSON_PTT_ENV_FILE;
  const originalSocketPath = process.env.BOSON_VILLAGE_IPC_SOCKET;
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'boson-native-ptt-'));
  const socketPath = join(directory, 'village.sock');
  process.env.BOSON_API_KEY = 'synthetic-test-key';
  delete process.env.BOSON_PTT_ENV_FILE;
  process.env.BOSON_VILLAGE_IPC_SOCKET = socketPath;
  let providerCalls = 0;
  let releaseProviderCredential: ((response: Response) => void) | undefined;
  let selectedResident = baseResident;
  const commands: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async () => {
    providerCalls += 1;
    return new Promise<Response>((resolve) => { releaseProviderCredential = resolve; });
  }) as typeof fetch;

  const ipcServer = createIpcServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const command = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      commands.push(command);
      if (command.type === 'ptt.native.begin') {
        socket.end(`${JSON.stringify({ version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId,
          status: 'ready', resident: selectedResident })}\n`);
        return;
      }
      const phase = command.type === 'ptt.session.bind' ? 'session'
        : command.type === 'ptt.speech.start' || command.type === 'ptt.speech.finish' ? 'speech'
          : command.type === 'ptt.player.speech.finish' ? 'player.speech' : 'native';
      const status = command.type === 'ptt.session.bind' ? 'bound'
        : command.type === 'ptt.speech.start' ? 'started'
          : command.type === 'ptt.player.speech.finish' ? 'queued'
            : command.type === 'ptt.speech.finish' ? 'finished' : 'ended';
      socket.end(`${JSON.stringify({ version: 1, type: `ptt.${phase}.ack`, turnId: command.turnId, status })}\n`);
    });
  });
  const httpServer = createHttpServer();
  let ptt: ReturnType<typeof createPttServer> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { ipcServer.once('error', reject); ipcServer.listen(socketPath, resolve); });
    await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
    const address = httpServer.address();
    assert.ok(address && typeof address !== 'string');
    ptt = createPttServer(address.port);
    httpServer.on('request', (request, response) => { if (!ptt?.handleRequest(request, response)) response.writeHead(404).end(); });
    const origin = `http://127.0.0.1:${address.port}`;
    const post = (path: string, payload: unknown) => originalFetch(`${origin}${path}`, {
      method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const firstResponse = await post('/boson-ptt/native/begin', { knownResidentSessionIds: [] });
    const first = await firstResponse.json() as Record<string, unknown>;
    assert.equal(firstResponse.status, 200);
    assert.equal(first.reuseSession, false);
    assert.equal(typeof first.turnId, 'string');
    assert.equal(typeof first.residentSessionId, 'string');
    assert.equal(first.providerSecret, undefined);
    assert.equal(providerCalls, 0);
    assert.match(String(first.instructions), /Anna said: “The garden workers brought vegetables\.”/);

    const firstCredentialRequest = post('/boson-ptt/native/credential', {
      turnId: first.turnId, residentSessionId: first.residentSessionId,
    });
    const secondCredentialRequest = await post('/boson-ptt/native/credential', {
      turnId: first.turnId, residentSessionId: first.residentSessionId,
    });
    assert.equal(secondCredentialRequest.status, 409);
    assert.equal(providerCalls, 1);
    assert.ok(releaseProviderCredential);
    releaseProviderCredential(new Response(JSON.stringify({
      value: 'bai-eph-test', expires_at: Math.floor(Date.now() / 1_000) + 60,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const credentials = await firstCredentialRequest;
    assert.equal(credentials.status, 200);
    const duplicateCredentials = await post('/boson-ptt/native/credential', {
      turnId: first.turnId, residentSessionId: first.residentSessionId,
    });
    assert.equal(duplicateCredentials.status, 409);

    const playerSpeech = await post('/boson-ptt/player-speech/finish', {
      turnId: first.turnId, residentSessionId: first.residentSessionId, itemId: 'input_item_1',
      transcript: 'Please water the seedlings.',
    });
    assert.equal(playerSpeech.status, 200);
    assert.deepEqual(commands.filter(({ type }) => type === 'ptt.player.speech.finish').map(({ turnId, residentSessionId, itemId, transcript }) =>
      ({ turnId, residentSessionId, itemId, transcript })), [{
      turnId: first.turnId, residentSessionId: first.residentSessionId, itemId: 'input_item_1', transcript: 'Please water the seedlings.',
    }]);
    const forgedPlayerSpeech = await post('/boson-ptt/player-speech/finish', {
      turnId: first.turnId, residentSessionId: first.residentSessionId, itemId: 'input_item_2',
      transcript: 'Come closer.', speakerId: 'pip',
    });
    assert.equal(forgedPlayerSpeech.status, 400);

    const start = await post('/boson-ptt/speech/start', {
      turnId: first.turnId, residentSessionId: first.residentSessionId, responseId: 'resp_1', itemId: 'item_1',
    });
    assert.equal(start.status, 200);
    const finish = await post('/boson-ptt/speech/finish', {
      turnId: first.turnId, residentSessionId: first.residentSessionId, responseId: 'resp_1', itemId: 'item_1',
      playback: 'completed', transcript: 'I set aside one loaf for every household.',
    });
    assert.equal(finish.status, 200);
    assert.equal(commands.some((command) => Object.hasOwn(command, 'speakerId')), false);
    assert.deepEqual(commands.filter(({ type }) => String(type).startsWith('ptt.speech')).map(({ type, turnId, residentSessionId, responseId, itemId }) =>
      ({ type, turnId, residentSessionId, responseId, itemId })), [
      { type: 'ptt.speech.start', turnId: first.turnId, residentSessionId: first.residentSessionId, responseId: 'resp_1', itemId: 'item_1' },
      { type: 'ptt.speech.finish', turnId: first.turnId, residentSessionId: first.residentSessionId, responseId: 'resp_1', itemId: 'item_1' },
    ]);

    const end = await post('/boson-ptt/native/end', { turnId: first.turnId, residentSessionId: first.residentSessionId });
    assert.equal(end.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1_010));
    selectedResident = { ...baseResident, responseOptions: [] };
    const secondResponse = await post('/boson-ptt/native/begin', { knownResidentSessionIds: [first.residentSessionId] });
    const second = await secondResponse.json() as Record<string, unknown>;
    assert.equal(secondResponse.status, 200);
    assert.notEqual(second.turnId, first.turnId);
    assert.equal(second.residentSessionId, first.residentSessionId);
    assert.equal(second.reuseSession, true);
    assert.match(String(second.instructions), /Follow the person and conversation wherever they go, including tangents/);
    assert.equal(commands.filter(({ type }) => type === 'ptt.native.begin').length, 2);
    assert.equal(providerCalls, 1, 'reusing the resident conversation does not fetch another credential');
    assert.equal(commands.filter(({ type }) => type === 'ptt.session.bind').length, 2);

    await post('/boson-ptt/native/end', { turnId: second.turnId, residentSessionId: second.residentSessionId });
    await new Promise((resolve) => setTimeout(resolve, 1_010));
    selectedResident = annaResident;
    const annaResponse = await post('/boson-ptt/native/begin', { knownResidentSessionIds: [first.residentSessionId] });
    const anna = await annaResponse.json() as Record<string, unknown>;
    assert.equal(annaResponse.status, 200);
    assert.equal(anna.residentId, 'mira');
    assert.notEqual(anna.residentSessionId, first.residentSessionId, 'Anna receives an independent persistent conversation session');
    assert.equal(anna.reuseSession, false);
    assert.match(String(anna.instructions), /Garden workers bring vegetables/);
    assert.doesNotMatch(String(anna.instructions), /set aside one loaf/);
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
