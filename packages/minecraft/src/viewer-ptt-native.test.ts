import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeResidentAudioClient } from './viewer-ptt-native.js';
import { encodePcm16 } from './audio/native-realtime-core.js';

class FakeTarget {
  listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event });
  }
}

class FakeSocket extends FakeTarget {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  url: string;
  protocols: string[];
  constructor(url: string, protocols: string[]) {
    super(); FakeSocket.instances.push(this);
    this.url = url; this.protocols = protocols;
    queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.dispatch('open'); });
  }
  send(raw: string) {
    const message = JSON.parse(raw); this.sent.push(message);
    if (message.type === 'session.update') queueMicrotask(() => this.dispatch('message', { data: JSON.stringify({
      type: 'session.updated', session: { output_modalities: ['audio'], audio: {
        input: { format: { type: 'audio/pcm', rate: 24_000 }, turn_detection: null,
          ...(message.session.audio.input.transcription ? { transcription: message.session.audio.input.transcription } : {}) },
        output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: message.session.audio.output.voice },
      }, tools: [], tool_choice: 'none' },
    }) }));
  }
  close() { this.readyState = 3; this.dispatch('close'); }
  message(value: unknown) { this.dispatch('message', { data: JSON.stringify(value) }); }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 10;
  destination = {};
  audioWorklet = { addModule: async () => undefined };
  sources: any[] = [];
  options: unknown;
  constructor(options: unknown) { FakeAudioContext.instances.push(this); this.options = options; }
  async resume() {}
  async close() {}
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel() {} };
  }
  createBufferSource() {
    const source: any = { connect() {}, disconnect() {}, start(time: number) { source.started = true; source.startAt = time; },
      stop() { source.stopped = true; source.onended?.(); } };
    this.sources.push(source); return source;
  }
  createGain() { return { connect() {}, disconnect() {}, gain: { setTargetAtTime(value: number) { this.value = value; } } }; }
  createStereoPanner() { return { connect() {}, disconnect() {}, pan: { setTargetAtTime(value: number) { this.value = value; } } }; }
  getOutputTimestamp() { return { contextTime: this.currentTime }; }
}

class FakeWorkletNode {
  port: any = { onmessage: null };
  connect() {}
  disconnect() {}
  constructor(_context: unknown, _name: string, _options: unknown) {}
}

const residents = [
  { turnId: 'turn_00000001', residentSessionId: 'session_pip_0001', residentId: 'pip', speakerName: 'Thomas', voice: 'jake', reuseSession: false },
  { turnId: 'turn_00000002', residentSessionId: 'session_mira_0002', residentId: 'mira', speakerName: 'Anna', voice: 'chloe', reuseSession: false },
];

function setupClient(options: { enableInputTranscription?: boolean; inputTranscriptionTimeoutMs?: number } = {}) {
  const requests: Array<{ path: string; body: any }> = [];
  const statuses: string[] = [];
  let beginIndex = 0;
  let micRequests = 0;
  const client = new NativeResidentAudioClient({
    fetchImpl: async (path: string, request: any) => {
      const body = request.body ? JSON.parse(request.body) : {};
      requests.push({ path, body });
      if (path === '/boson-ptt/native/begin') {
        const data = residents[beginIndex++];
        return { ok: true, status: 200, json: async () => ({ available: true, ...data, instructions: `Prompt for ${data.residentId}` }) };
      }
      if (path === '/boson-ptt/native/credential') return { ok: true, status: 200, json: async () => ({ available: true, clientSecret: 'bai-eph-test', expiresAt: 1_900_000_000 }) };
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    },
    WebSocketClass: FakeSocket as any,
    AudioContextClass: FakeAudioContext as any,
    AudioWorkletNodeClass: FakeWorkletNode as any,
    EventSourceClass: undefined,
    getPositionSocket: () => null,
    ...options,
    onStatus: (status: string) => statuses.push(status),
    mediaDevices: { getUserMedia: async () => {
      micRequests += 1;
      return { getTracks: () => [{ stop() {} }] };
    } },
  });
  return { client, requests, statuses, micRequests: () => micRequests };
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

test('actual main-world client opens mic only on held gesture and keeps resident Realtime sockets isolated', async () => {
  FakeSocket.instances = []; FakeAudioContext.instances = [];
  const { client, requests, statuses, micRequests } = setupClient({ enableInputTranscription: true });
  assert.equal(FakeAudioContext.instances.length, 0);
  assert.equal(micRequests(), 0);
  client.updateResidentPositions(JSON.stringify({ type: 'village.residents', timestamp: 10,
    residents: [
      { residentId: 'pip', name: 'Thomas', position: { x: 2, y: 0, z: 0 } },
      { residentId: 'mira', name: 'Anna', position: { x: -3, y: 0, z: 0 } },
    ] }));
  client.updateListenerPosition({ pos: { x: 0, y: 0, z: 0 }, yaw: 0 });

  await client.beginHeldTurn('key');
  assert.equal(FakeAudioContext.instances.length, 1, 'AudioContext is initialized by the user gesture');
  assert.equal(micRequests(), 1, `microphone starts only after the native session is configured: ${statuses.join(',')}`);
  const first = client.turn;
  assert.equal(first.residentId, 'pip');
  client.releaseHeldTurn();
  await client.handleRealtimeEvent(first.connection, { type: 'input_audio_buffer.committed', item_id: 'input_item_1' });
  await client.handleRealtimeEvent(first.connection, { type: 'response.done', response: { id: 'resp_empty_1', status: 'completed' } });
  assert.equal(requests.some(({ path, body }) => path === '/boson-ptt/native/end' && body.turnId === first.turnId), false,
    'server binding remains active until the final input transcription is acknowledged');
  await client.handleRealtimeEvent(first.connection, { type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'input_item_1', transcript: 'Please show me the bakery.' });
  await settle();
  await settle();
  assert.ok(requests.some(({ path, body }) => path === '/boson-ptt/native/end' && body.turnId === first.turnId));
  assert.deepEqual(requests.find(({ path }) => path === '/boson-ptt/player-speech/finish')?.body,
    { turnId: first.turnId, residentSessionId: first.residentSessionId, itemId: 'input_item_1', transcript: 'Please show me the bakery.' });

  await client.beginHeldTurn('key');
  const second = client.turn;
  assert.equal(second.residentId, 'mira');
  assert.notEqual(second.connection.socket, first.connection.socket);
  assert.notEqual(second.connection.playback, first.connection.playback);
  assert.deepEqual([...client.connections.keys()], ['session_pip_0001', 'session_mira_0002']);
  assert.deepEqual(client.mixer.listener, { x: 0, y: 0, z: 0, yaw: 0 }, 'cached listener pose hydrates a cold mixer');
  assert.deepEqual(client.mixer.speakers.get('mira'), { x: -3, y: 0, z: 0 }, 'cached resident pose hydrates a cold mixer');
  client.stop();
});

test('actual client mixes native PCM at authoritative resident position and retains transcript until full playback drain', async () => {
  FakeSocket.instances = []; FakeAudioContext.instances = [];
  const { client, requests } = setupClient();
  client.updateResidentPositions(JSON.stringify({ type: 'village.residents', timestamp: 10,
    residents: [{ residentId: 'pip', name: 'Thomas', position: { x: 8, y: 0, z: 0 } }] }));
  client.updateListenerPosition({ pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
  await client.beginHeldTurn('pointer');
  const turn = client.turn;
  client.releaseHeldTurn();
  await client.handleRealtimeEvent(turn.connection, { type: 'input_audio_buffer.committed' });
  await client.handleRealtimeEvent(turn.connection, { type: 'response.created', response: { id: 'resp_audio_1' } });
  await client.handleRealtimeEvent(turn.connection, { type: 'response.output_audio_transcript.delta', response_id: 'resp_audio_1', item_id: 'item_audio_1', delta: 'I saved you a loaf.' });
  await client.handleRealtimeEvent(turn.connection, { type: 'response.output_audio.delta', response_id: 'resp_audio_1', item_id: 'item_partial',
    content_index: 0, delta: btoa(String.fromCharCode(0x00)) });
  assert.equal(turn.connection.pendingByteMap.size, 1);
  await client.handleRealtimeEvent(turn.connection, { type: 'response.output_audio.delta', response_id: 'resp_audio_1', item_id: 'item_audio_1', content_index: 0, delta: encodePcm16(new Float32Array(2_400)) });
  const context = FakeAudioContext.instances[0];
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0].started, true);
  assert.equal(client.mixer.speakers.get('pip').x, 8);
  await client.handleRealtimeEvent(turn.connection, { type: 'response.done', response: { id: 'resp_audio_1', status: 'completed' } });
  assert.equal(turn.connection.pendingByteMap.size, 0, 'response completion discards unmatched odd PCM bytes');
  assert.ok(client.connections.get(turn.residentSessionId).outputItems.size > 0, 'transcript remains ephemeral until audio drains');
  context.sources[0].onended();
  await settle(); await settle();
  const finish = requests.find(({ path }) => path === '/boson-ptt/speech/finish');
  assert.deepEqual(finish?.body, {
    turnId: turn.turnId, residentSessionId: turn.residentSessionId, responseId: 'resp_audio_1', itemId: 'item_audio_1',
    playback: 'completed', transcript: 'I saved you a loaf.',
  });
  assert.equal(client.connections.get(turn.residentSessionId).outputItems.size, 0);
  client.stop();
});

test('actual client ends a begin request canceled by P release before credentials or microphone access', async () => {
  FakeSocket.instances = []; FakeAudioContext.instances = [];
  let resolveBegin: ((value: any) => void) | undefined;
  const requests: string[] = [];
  let micRequests = 0;
  const client = new NativeResidentAudioClient({
    fetchImpl: async (path: string) => {
      requests.push(path);
      if (path === '/boson-ptt/native/begin') return new Promise((resolve) => { resolveBegin = (data) => resolve({ ok: true, status: 200, json: async () => data }); });
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    },
    WebSocketClass: FakeSocket as any, AudioContextClass: FakeAudioContext as any, AudioWorkletNodeClass: FakeWorkletNode as any,
    EventSourceClass: undefined, getPositionSocket: () => null,
    mediaDevices: { getUserMedia: async () => { micRequests += 1; return { getTracks: () => [] }; } },
  });
  const starting = client.beginHeldTurn('key');
  await settle();
  client.releaseHeldTurn();
  resolveBegin?.({ available: true, ...residents[0], instructions: 'Prompt' });
  await starting;
  assert.equal(requests.includes('/boson-ptt/native/credential'), false);
  assert.equal(requests.includes('/boson-ptt/native/end'), true);
  assert.equal(micRequests, 0);
  client.stop();
});

test('input transcription is disabled by default and does not gate proximity turn completion', async () => {
  FakeSocket.instances = []; FakeAudioContext.instances = [];
  const { client, requests } = setupClient();
  await client.beginHeldTurn('key');
  const turn = client.turn;
  const sessionUpdate = turn.connection.socket.sent.find(({ type }) => type === 'session.update');
  assert.equal(sessionUpdate.session.audio.input.transcription, undefined);
  client.releaseHeldTurn();
  await client.handleRealtimeEvent(turn.connection, { type: 'input_audio_buffer.committed', item_id: 'no-stt-item' });
  await client.handleRealtimeEvent(turn.connection, { type: 'response.done', response: { id: 'resp_no_stt', status: 'completed' } });
  await settle(); await settle();
  assert.ok(requests.some(({ path, body }) => path === '/boson-ptt/native/end' && body.turnId === turn.turnId));
  assert.equal(requests.some(({ path }) => path === '/boson-ptt/player-speech/finish'), false);
  client.stop();
});

test('opt-in input transcription configures Higgs STT and times out without stranding the native turn', async () => {
  FakeSocket.instances = []; FakeAudioContext.instances = [];
  const { client, requests } = setupClient({ enableInputTranscription: true, inputTranscriptionTimeoutMs: 100 });
  await client.beginHeldTurn('key');
  const turn = client.turn;
  const sessionUpdate = turn.connection.socket.sent.find(({ type }) => type === 'session.update');
  assert.deepEqual(sessionUpdate.session.audio.input.transcription, { model: 'higgs-stt-3.1', language: 'en' });
  client.releaseHeldTurn();
  await client.handleRealtimeEvent(turn.connection, { type: 'input_audio_buffer.committed', item_id: 'stt-timeout-item' });
  await client.handleRealtimeEvent(turn.connection, { type: 'response.done', response: { id: 'resp_stt_timeout', status: 'completed' } });
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.ok(requests.some(({ path, body }) => path === '/boson-ptt/native/end' && body.turnId === turn.turnId));
  assert.equal(requests.some(({ path }) => path === '/boson-ptt/player-speech/finish'), false);
  client.stop();
});

test('socket failure after microphone release clears active reply and lets the next held turn proceed', async () => {
  FakeSocket.instances = []; FakeAudioContext.instances = [];
  const { client, requests } = setupClient();
  await client.beginHeldTurn('key');
  const failedTurn = client.turn;
  client.releaseHeldTurn();
  failedTurn.responseInProgress = true;
  failedTurn.connection.socket.close();
  await settle(); await settle();
  assert.equal(client.turn, null);
  assert.ok(requests.some(({ path, body }) => path === '/boson-ptt/native/end' && body.turnId === failedTurn.turnId));
  client.stop();
});

test('barge-in cancels generation, truncates heard audio, and begins a fresh per-hold turn', async () => {
  FakeSocket.instances = []; FakeAudioContext.instances = [];
  const { client, requests } = setupClient();
  client.updateResidentPositions(JSON.stringify({ type: 'village.residents', timestamp: 10,
    residents: [{ residentId: 'pip', name: 'Thomas', position: { x: 3, y: 0, z: 0 } }] }));
  await client.beginHeldTurn('key');
  const first = client.turn;
  client.releaseHeldTurn();
  await client.handleRealtimeEvent(first.connection, { type: 'input_audio_buffer.committed' });
  await client.handleRealtimeEvent(first.connection, { type: 'response.created', response: { id: 'resp_barge_1' } });
  await client.handleRealtimeEvent(first.connection, { type: 'response.output_audio.delta', response_id: 'resp_barge_1', item_id: 'item_barge_1',
    content_index: 0, delta: encodePcm16(new Float32Array(2_400)) });

  await client.beginHeldTurn('key');
  await client.handleRealtimeEvent(first.connection, { type: 'response.done', response: { id: 'resp_barge_1', status: 'cancelled' } });
  await settle(); await settle(); await settle();
  const sent = first.connection.socket.sent.map(({ type, item_id }) => ({ type, item_id }));
  assert.ok(sent.some(({ type }) => type === 'response.cancel'));
  assert.ok(sent.some(({ type, item_id }) => type === 'conversation.item.truncate' && item_id === 'item_barge_1'));
  assert.ok(requests.some(({ path, body }) => path === '/boson-ptt/speech/finish' && body.playback === 'interrupted'));
  assert.equal(client.turn?.turnId, residents[1].turnId, 'next hold creates a new server turn after the prior output drains');
  client.stop();
});
