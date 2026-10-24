import assert from 'node:assert/strict';
import test from 'node:test';

class MockTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, preventDefault() {}, ...event });
  }
}

class MockElement extends MockTarget {
  dataset = {};
  attributes = {};
  children = [];
  disabled = false;
  textContent = '';
  tagName = 'BUTTON';

  setAttribute(name, value) { this.attributes[name] = value; }
  setPointerCapture() {}
  append(element) { this.children.push(element); }
  get firstElementChild() { return this.children[0] ?? null; }
  remove() { this.removed = true; }
}

class MockWebSocket extends MockTarget {
  static OPEN = 1;
  static CLOSING = 2;
  readyState = 0;
  sent = [];

  constructor() { super(); MockWebSocket.instances.push(this); }
  send(message) { this.sent.push(JSON.parse(message)); }
  close() { this.readyState = 3; }
  open() { this.readyState = MockWebSocket.OPEN; this.dispatch('open'); }
  message(value) { this.dispatch('message', { data: JSON.stringify(value) }); }
}
MockWebSocket.instances = [];

class MockAudioContext {
  state = 'running';
  currentTime = 10;
  destination = {};
  audioWorklet = { addModule: async () => undefined };
  sources = [];
  close() { this.state = 'closed'; return Promise.resolve(); }
  resume() { return Promise.resolve(); }
  getOutputTimestamp() { return { contextTime: this.currentTime }; }
  createBuffer(_channels, length) { return { copyToChannel() {}, duration: length / 24_000 }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start: (time) => { source.startAt = time; }, stop: () => { source.stopped = true; } };
    this.sources.push(source);
    return source;
  }
}

class MockAudioWorkletNode {
  port = { onmessage: null };
  connect() {}
  disconnect() {}
}

function installBrowserFakes() {
  const names = ['document', 'window', 'navigator', 'WebSocket', 'AudioContext', 'AudioWorkletNode', 'fetch', 'CustomEvent'];
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const ids = new Map();
  for (const id of [
    'start-session', 'end-session', 'talk', 'diagnostic-list', 'turn-count', 'input-duration', 'output-duration',
    'cost-estimate', 'audio-tokens', 'session-age', 'credential-expiry', 'session-state', 'turn-state', 'response-state',
  ]) ids.set(id, new MockElement());
  const document = new MockTarget();
  document.getElementById = (id) => ids.get(id);
  document.createElement = () => new MockElement();
  document.visibilityState = 'visible';
  const window = new MockTarget();
  window.setInterval = () => 1;
  window.clearInterval = () => undefined;
  window.setTimeout = globalThis.setTimeout;
  window.clearTimeout = globalThis.clearTimeout;
  const tracks = [];
  const mediaDevices = {
    getUserMedia: async () => {
      const track = { stopCount: 0, stop() { this.stopCount += 1; } };
      tracks.push(track);
      return { getTracks: () => [track] };
    },
  };
  const audioContexts = [];
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: document },
    window: { configurable: true, value: window },
    navigator: { configurable: true, value: { mediaDevices } },
    WebSocket: { configurable: true, value: MockWebSocket },
    AudioContext: { configurable: true, value: class extends MockAudioContext { constructor() { super(); audioContexts.push(this); } } },
    AudioWorkletNode: { configurable: true, value: MockAudioWorkletNode },
    CustomEvent: { configurable: true, value: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } },
    fetch: { configurable: true, value: async (url) => url === '/native/session/start'
      ? { ok: true, json: async () => ({ available: true, clientSecret: 'bai-eph-test', sessionId: 'local-session', expiresAt: 1_900_000_000 }) }
      : { ok: true, status: 204, json: async () => ({}) } },
  });
  MockWebSocket.instances = [];
  return {
    document, window, ids, tracks, audioContexts,
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

async function bootMockedLab(t) {
  const fakes = installBrowserFakes();
  t.after(fakes.restore);
  await import(`../boson-api-demo/ptt-native-audio.js?lifecycle=${Math.random()}`);
  fakes.ids.get('start-session').dispatch('click');
  await flush();
  const socket = MockWebSocket.instances.at(-1);
  assert.ok(socket);
  socket.open();
  socket.message({
    type: 'session.updated',
    session: {
      output_modalities: ['audio'],
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24_000 }, turn_detection: null },
        output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: 'chloe' },
      },
      tools: [], tool_choice: 'none',
    },
  });
  return { ...fakes, socket };
}

const audioDelta = (responseId, itemId) => ({
  type: 'response.output_audio.delta',
  response_id: responseId,
  item_id: itemId,
  content_index: 0,
  delta: Buffer.alloc(48_000).toString('base64'),
});

test('held P cancels an active reply, ignores late audio, truncates heard PCM, then commits once on release', async (t) => {
  const { ids, socket, audioContexts, window } = await bootMockedLab(t);
  socket.message({ type: 'response.created', response: { id: 'resp_active' } });
  socket.message(audioDelta('resp_active', 'item_active'));
  audioContexts[0].currentTime = 10.4;

  ids.get('talk').dispatch('pointerdown', { preventDefault() {}, pointerId: 1 });
  await flush();
  assert.equal(audioContexts[0].sources[0].stopped, true);
  assert.ok(socket.sent.some((message) => message.type === 'response.cancel'));
  assert.equal(ids.get('talk').disabled, false);
  const sourcesBeforeLateDelta = audioContexts[0].sources.length;
  socket.message(audioDelta('resp_active', 'item_active'));
  assert.equal(audioContexts[0].sources.length, sourcesBeforeLateDelta);

  window.dispatch('pointerup');
  assert.equal(socket.sent.some((message) => message.type === 'input_audio_buffer.commit'), false);
  socket.message({ type: 'response.done', response: { id: 'resp_active', status: 'cancelled' } });
  const truncateIndex = socket.sent.findIndex((message) => message.type === 'conversation.item.truncate');
  const commitIndex = socket.sent.findIndex((message) => message.type === 'input_audio_buffer.commit');
  assert.ok(truncateIndex >= 0);
  assert.ok(commitIndex > truncateIndex);
  assert.equal(socket.sent[truncateIndex].audio_end_ms, 400);
  assert.equal(socket.sent.filter((message) => message.type === 'input_audio_buffer.commit').length, 1);
  socket.message({ type: 'input_audio_buffer.committed' });
  assert.equal(socket.sent.filter((message) => message.type === 'response.create').length, 1);
});

test('held P after response.done truncates queued output and blur releases the mocked capture track', async (t) => {
  const { ids, socket, audioContexts, window, tracks } = await bootMockedLab(t);
  socket.message({ type: 'response.created', response: { id: 'resp_queued' } });
  socket.message(audioDelta('resp_queued', 'item_queued'));
  socket.message({ type: 'response.done', response: { id: 'resp_queued', status: 'completed' } });
  audioContexts[0].currentTime = 10.25;

  assert.equal(ids.get('talk').disabled, false);
  ids.get('talk').dispatch('pointerdown', { preventDefault() {}, pointerId: 2 });
  await flush();
  assert.equal(socket.sent.some((message) => message.type === 'response.cancel'), false);
  const truncation = socket.sent.find((message) => message.type === 'conversation.item.truncate');
  assert.deepEqual(truncation, {
    type: 'conversation.item.truncate', item_id: 'item_queued', content_index: 0, audio_end_ms: 250,
  });
  assert.equal(audioContexts[0].sources[0].stopped, true);

  window.dispatch('blur');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].stopCount, 1);
  assert.equal(ids.get('turn-state').textContent, 'Microphone released · finishing this turn…');
});

test('cancel-not-active race completes the interrupted turn without ending the persistent session', async (t) => {
  const { ids, socket, audioContexts, window } = await bootMockedLab(t);
  socket.message({ type: 'response.created', response: { id: 'resp_race' } });
  socket.message(audioDelta('resp_race', 'item_race'));
  audioContexts[0].currentTime = 10.1;
  ids.get('talk').dispatch('pointerdown', { preventDefault() {}, pointerId: 3 });
  await flush();
  window.dispatch('pointerup');

  socket.message({ type: 'error', error: { code: 'response_cancel_not_active' } });
  assert.equal(ids.get('end-session').disabled, false);
  assert.equal(socket.sent.some((message) => message.type === 'conversation.item.truncate' && message.audio_end_ms === 100), true);
  assert.equal(socket.sent.filter((message) => message.type === 'input_audio_buffer.commit').length, 1);
});

test('response.done before cancel-not-active error preserves the session and next response', async (t) => {
  const { ids, socket, audioContexts, window } = await bootMockedLab(t);
  socket.message({ type: 'response.created', response: { id: 'resp_reverse_race' } });
  socket.message(audioDelta('resp_reverse_race', 'item_reverse_race'));
  audioContexts[0].currentTime = 10.1;
  ids.get('talk').dispatch('pointerdown', { preventDefault() {}, pointerId: 4 });
  await flush();
  window.dispatch('pointerup');

  socket.message({ type: 'response.done', response: { id: 'resp_reverse_race', status: 'completed' } });
  socket.message({ type: 'error', error: { code: 'response_cancel_not_active' } });
  assert.equal(ids.get('end-session').disabled, false);
  socket.message({ type: 'input_audio_buffer.committed' });
  assert.equal(socket.sent.filter((message) => message.type === 'response.create').length, 1);
  assert.equal(socket.sent.filter((message) => message.type === 'input_audio_buffer.commit').length, 1);
});
