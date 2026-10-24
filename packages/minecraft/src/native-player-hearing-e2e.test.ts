import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { NativeResidentAudioClient, nativeHearingOptionsFromSearch } from './viewer-ptt-native.js';
import { createPttServer } from './viewer-ptt-server.ts';
import { isVillagePttCommand } from './village-event.ts';
import { VillageHeardSpeechMemory } from './village-heard-speech-memory.ts';
import { buildNativeResidentInstructions } from './native-resident-context.ts';
import { NativePlayerSpeechHandler } from './village-native-player-speech-handler.ts';
import { createVillagePttIpcBridge } from '../../../scripts/village-ptt-ipc-bridge.mjs';

class FakeRealtimeSocket {
  static OPEN = 1;
  readyState = 0;
  listeners = new Map<string, Set<(event: any) => void>>();
  sent: Array<Record<string, any>> = [];
  constructor(_url: string, _protocols: string[]) {
    queueMicrotask(() => { this.readyState = 1; this.dispatch('open'); });
  }
  addEventListener(type: string, listener: (event: any) => void) {
    const current = this.listeners.get(type) ?? new Set(); current.add(listener); this.listeners.set(type, current);
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event });
  }
  send(raw: string) {
    const message = JSON.parse(raw); this.sent.push(message);
    if (message.type === 'session.update') queueMicrotask(() => this.dispatch('message', { data: JSON.stringify({
      type: 'session.updated', session: { ...message.session, tools: [], tool_choice: 'none' },
    }) }));
  }
  close() { this.readyState = 3; this.dispatch('close'); }
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  audioWorklet = { addModule: async () => undefined };
  constructor(_options: unknown) {}
  async resume() {}
  async close() {}
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}

class FakeWorkletNode {
  port: { onmessage: ((event: { data: unknown }) => void) | null } = { onmessage: null };
  constructor(_context: unknown, _name: string, _options: unknown) {}
  connect() {}
  disconnect() {}
}

const testResident = {
  id: 'pip', name: 'Thomas', role: 'baker', goal: 'keep the bakery running', locationId: 'bakery-hearth',
  topics: [], facts: [], responseOptions: [], relationship: 'unfamiliar', recentHeardSpeech: [],
};

function playerSamples() {
  return [
    { tick: 1_000, speakerPosition: { x: 0, y: 64, z: 0 }, residents: [
      { residentId: 'mira', position: { x: 4, y: 64, z: 0 } },
      { residentId: 'tobin', position: { x: 7, y: 64, z: 0 } },
      { residentId: 'pip', position: { x: 20, y: 64, z: 0 } },
    ] },
    { tick: 2_000, speakerPosition: { x: 1, y: 64, z: 0 }, residents: [
      { residentId: 'mira', position: { x: 5, y: 64, z: 0 } },
      { residentId: 'tobin', position: { x: 8, y: 64, z: 0 } },
      { residentId: 'pip', position: { x: 21, y: 64, z: 0 } },
    ] },
  ];
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('opt-in player speech traverses native client, HTTP server, production relay and engine memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boson-player-hearing-'));
  const socketPath = join(directory, 'village.sock');
  const oldKey = process.env.BOSON_API_KEY;
  const oldSocketPath = process.env.BOSON_VILLAGE_IPC_SOCKET;
  const oldFetch = globalThis.fetch;
  process.env.BOSON_API_KEY = 'synthetic-test-key';
  process.env.BOSON_VILLAGE_IPC_SOCKET = socketPath;
  let syntheticCredentialCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === 'https://api.boson.ai/v1/realtime/client_secrets') {
      syntheticCredentialCalls += 1;
      return Response.json({ value: 'bai-eph-provider-disabled-test', expires_at: Math.floor(Date.now() / 1_000) + 300 });
    }
    return oldFetch(input, init);
  }) as typeof fetch;

  const engine = { stdin: new PassThrough(), stdout: new PassThrough() };
  const bridge = createVillagePttIpcBridge({ socketPath, village: engine });
  const outputLines = createInterface({ input: engine.stdout, crlfDelay: Infinity });
  outputLines.on('line', (line) => {
    try { bridge.deliverAck(JSON.parse(line)); } catch { /* malformed engine fixture output is ignored like the runtime relay */ }
  });
  const heard = new VillageHeardSpeechMemory(3, 180_000);
  const playerSpeechHandler = new NativePlayerSpeechHandler(heard);
  const activeTurns = new Map<string, { turnId: string; residentSessionId?: string; playerSpeechSamplingComplete: boolean; playerSpeechSamples: ReturnType<typeof playerSamples> }>();
  const commands: Array<Record<string, any>> = [];
  let failNextTranscript = false;

  const sendEngineEvent = (event: Record<string, unknown>) => engine.stdout.write(`${JSON.stringify(event)}\n`);
  engine.stdin.on('data', (chunk: Buffer) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      const command = JSON.parse(line) as Record<string, any>;
      assert.equal(isVillagePttCommand(command), true, `relay forwarded a valid engine command: ${command.type}`);
      commands.push(command);
      if (command.type === 'ptt.native.begin') {
        activeTurns.set(command.turnId, { turnId: command.turnId, playerSpeechSamplingComplete: true, playerSpeechSamples: playerSamples() });
        sendEngineEvent({ version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId, status: 'ready', resident: testResident });
      } else if (command.type === 'ptt.session.bind') {
        const turn = activeTurns.get(command.turnId);
        if (turn) turn.residentSessionId = command.residentSessionId;
        sendEngineEvent({ version: 1, type: 'ptt.session.ack', turnId: command.turnId, status: 'bound' });
      } else if (command.type === 'ptt.player.speech.finish') {
        let status: string;
        if (failNextTranscript) { failNextTranscript = false; status = 'unavailable'; }
        else status = playerSpeechHandler.finish(activeTurns.get(command.turnId), command);
        sendEngineEvent({ version: 1, type: 'ptt.player.speech.ack', turnId: command.turnId, itemId: command.itemId, status });
      } else if (command.type === 'ptt.native.end') {
        const turn = activeTurns.get(command.turnId);
        if (turn) playerSpeechHandler.complete(turn);
        activeTurns.delete(command.turnId);
        sendEngineEvent({ version: 1, type: 'ptt.native.ack', turnId: command.turnId, status: 'ended' });
      } else {
        throw new Error(`Unexpected engine command ${command.type}`);
      }
    }
  });

  let ptt: ReturnType<typeof createPttServer> | undefined;
  const httpServer = createHttpServer((request, response) => {
    if (!ptt?.handleRequest(request, response)) response.writeHead(404).end();
  });
  let client: NativeResidentAudioClient | undefined;
  try {
    await bridge.start();
    await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
    const address = httpServer.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    ptt = createPttServer(address.port);
    const options = nativeHearingOptionsFromSearch('?nativeResidentAudio=1&nativePlayerHearing=1');
    const statuses: string[] = [];
    client = new NativeResidentAudioClient({
      ...options,
      WebSocketClass: FakeRealtimeSocket as any,
      AudioContextClass: FakeAudioContext as any,
      AudioWorkletNodeClass: FakeWorkletNode as any,
      EventSourceClass: undefined,
      getPositionSocket: () => null,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      fetchImpl: async (path: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
        return oldFetch(new URL(path, origin), { ...init, headers });
      },
      onStatus: (status: string) => statuses.push(status),
    });

    await client.beginHeldTurn('fixture-key');
    const firstTurn = client.turn;
    assert.equal(firstTurn.residentId, 'pip');
    const sessionUpdate = firstTurn.connection.socket.sent.find(({ type }) => type === 'session.update');
    assert.deepEqual(sessionUpdate.session.audio.input.transcription, { model: 'higgs-stt-3.1', language: 'en' });
    client.releaseHeldTurn();
    await client.handleRealtimeEvent(firstTurn.connection, { type: 'input_audio_buffer.committed', item_id: 'player_item_1' });
    await client.handleRealtimeEvent(firstTurn.connection, { type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'player_item_1', transcript: 'The gardens need water.' });
    const finishCommand = commands.find((command) => command.type === 'ptt.player.speech.finish');
    assert.ok(finishCommand);
    assert.deepEqual(Object.keys(finishCommand).sort(), ['at', 'itemId', 'residentSessionId', 'transcript', 'turnId', 'type', 'version']);
    const replay = await oldFetch(new URL('/boson-ptt/player-speech/finish', origin), {
      method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: firstTurn.turnId, residentSessionId: firstTurn.residentSessionId,
        itemId: 'player_item_1', transcript: 'The gardens need water.' }),
    });
    assert.equal(replay.status, 409, 'same-turn duplicate item receives the engine duplicate ACK');
    await client.handleRealtimeEvent(firstTurn.connection, { type: 'response.done', response: { id: 'response_1', status: 'completed' } });
    await waitFor(() => client!.turn === null, 'first released turn ended after the transcript ACK');
    assert.ok(commands.some(({ type, turnId }) => type === 'ptt.native.end' && turnId === firstTurn.turnId));
    assert.deepEqual(heard.recent('mira', 2_000).map(({ text }) => text), ['The gardens need water.']);
    assert.deepEqual(heard.recent('tobin', 2_000).map(({ text }) => text), ['The gardens need water.']);
    assert.deepEqual(heard.recent('pip', 2_000), [], 'distant resident receives no player words');
    const prompt = (residentId: string, name: string) => buildNativeResidentInstructions({
      id: residentId, name, role: 'villager', goal: 'help the village', locationId: 'market-well', topics: [], facts: [],
      responseOptions: [], relationship: 'unfamiliar', recentHeardSpeech: heard.recent(residentId, 2_000),
    });
    assert.match(prompt('mira', 'Anna'), /the player said: “The gardens need water\.”/);
    assert.match(prompt('tobin', 'James'), /the player said: “The gardens need water\.”/);
    assert.doesNotMatch(prompt('pip', 'Thomas'), /The gardens need water/);

    const stale = await oldFetch(new URL('/boson-ptt/player-speech/finish', origin), {
      method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: firstTurn.turnId, residentSessionId: firstTurn.residentSessionId,
        itemId: 'stale_item', transcript: 'The gardens need water.' }),
    });
    assert.equal(stale.status, 410, 'a transcript after end is rejected without entering the relay');

    failNextTranscript = true;
    await new Promise((resolve) => setTimeout(resolve, 1_010));
    await client.beginHeldTurn('retry-key');
    const failedTurn = client.turn;
    await waitFor(() => statuses.at(-1) === 'listening', 'reused resident session resumed microphone capture');
    client.releaseHeldTurn();
    await client.handleRealtimeEvent(failedTurn.connection, { type: 'input_audio_buffer.committed', item_id: 'failed_item' });
    await client.handleRealtimeEvent(failedTurn.connection, { type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'failed_item', transcript: 'A temporary bridge failure.' });
    assert.ok(statuses.includes('player_transcript_failed'), `${statuses.join(',')} / ${commands.map(({ type, turnId, itemId }) => `${type}:${turnId}:${itemId ?? ''}`).join('|')}`);
    await client.handleRealtimeEvent(failedTurn.connection, { type: 'response.done', response: { id: 'response_2', status: 'completed' } });
    await waitFor(() => client!.turn === null, 'failed transcript ACK still ends the released turn');
    assert.ok(commands.some(({ type, turnId }) => type === 'ptt.native.end' && turnId === failedTurn.turnId),
      'failed player ACK still closes the released native turn');

    await new Promise((resolve) => setTimeout(resolve, 1_010));
    await client.beginHeldTurn('next-key');
    const retryTurn = client.turn;
    await waitFor(() => statuses.at(-1) === 'listening', 'resident session resumed capture for retry');
    client.releaseHeldTurn();
    await client.handleRealtimeEvent(retryTurn.connection, { type: 'input_audio_buffer.committed', item_id: 'retry_item' });
    await client.handleRealtimeEvent(retryTurn.connection, { type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'retry_item', transcript: 'The next item can be heard.' });
    await client.handleRealtimeEvent(retryTurn.connection, { type: 'response.done', response: { id: 'response_3', status: 'completed' } });
    await waitFor(() => client!.turn === null, 'retry turn ended after its transcript ACK');
    assert.ok(commands.some(({ type, turnId }) => type === 'ptt.native.end' && turnId === retryTurn.turnId),
      'a new item can succeed in a later turn after the failure');
    assert.equal(syntheticCredentialCalls, 1, 'only a synthetic provider-disabled credential fixture ran');
  } finally {
    client?.stop();
    ptt?.close();
    bridge.close();
    outputLines.close();
    engine.stdin.destroy(); engine.stdout.destroy();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.BOSON_API_KEY; else process.env.BOSON_API_KEY = oldKey;
    if (oldSocketPath === undefined) delete process.env.BOSON_VILLAGE_IPC_SOCKET; else process.env.BOSON_VILLAGE_IPC_SOCKET = oldSocketPath;
    globalThis.fetch = oldFetch;
  }
});
