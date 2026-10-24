import assert from 'node:assert/strict';
import test from 'node:test';
import { startViewerAudio } from './viewer-audio.js';

class FakeElement {
  attributes = new Map();
  children = new Map();
  listeners = new Map();
  removed = false;
  textContent = '';

  set innerHTML(markup) {
    for (const [, id] of markup.matchAll(/id="([^"]+)"/g)) this.children.set(id, new FakeElement());
    this.children.get('boson-line').textContent = 'Enable audio to hear nearby residents.';
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  append() {}
  remove() { this.removed = true; }
  querySelector(selector) { return this.children.get(selector.slice(1)); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
  click() { return this.listeners.get('click')?.({ currentTarget: this }); }
}

function browserHarness(fetcher) {
  const previous = Object.fromEntries(['document', 'window', 'EventSource', 'fetch'].map((key) => [key, globalThis[key]]));
  const eventSources = [];
  const elements = [];
  const contexts = [];
  const spoken = [];
  let cancelCount = 0;
  const makeNode = () => ({ connect() {}, disconnect() {}, gain: { setTargetAtTime() {} }, pan: { setTargetAtTime() {} } });

  class AudioContextMock {
    constructor() { this.currentTime = 0; this.destination = {}; this.sources = []; this.state = 'running'; contexts.push(this); }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
    async decodeAudioData() { return { duration: 1 }; }
    createGain() { return makeNode(); }
    createStereoPanner() { return makeNode(); }
    createBufferSource() {
      const source = {
        connect() {}, disconnect() {}, start() { this.started = true; },
        stop() { this.stopped = true; this.onended?.(); },
      };
      this.sources.push(source);
      return source;
    }
  }

  class EventSourceMock {
    constructor() { this.listeners = new Map(); this.closed = false; eventSources.push(this); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() { this.closed = true; }
    emit(name, data) { if (!this.closed) this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  }

  class SpeechUtteranceMock { constructor(text) { this.text = text; } }
  const socket = {
    listeners: new Map(), closed: false,
    on(name, listener) { this.listeners.set(name, listener); },
    close() { this.closed = true; },
    position(packet) { this.listeners.get('position')?.(packet); },
  };
  const speechSynthesis = {
    getVoices: () => [{ lang: 'en-US' }],
    speak: (utterance) => spoken.push(utterance),
    cancel: () => { cancelCount += 1; },
    addEventListener() {}, removeEventListener() {}, pause() {}, resume() {},
  };
  const windowListeners = new Map();
  const windowMock = {
    AudioContext: AudioContextMock,
    SpeechSynthesisUtterance: SpeechUtteranceMock,
    speechSynthesis,
    navigator: { language: 'en-US' },
    io: () => socket,
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener(name, listener) { if (windowListeners.get(name) === listener) windowListeners.delete(name); },
  };
  const documentMock = {
    documentElement: { lang: 'en-US' },
    head: { append() {} },
    body: { append() {} },
    createElement() { const element = new FakeElement(); elements.push(element); return element; },
  };
  globalThis.document = documentMock;
  globalThis.window = windowMock;
  globalThis.EventSource = EventSourceMock;
  globalThis.fetch = (...args) => fetcher(...args);

  const cleanup = startViewerAudio();
  return {
    cleanup,
    eventSource: eventSources[0],
    socket,
    contexts,
    spoken,
    elements,
    get cancelCount() { return cancelCount; },
    get fetchCalls() { return fetcher.calls; },
    firePageHide() { windowListeners.get('pagehide')?.(); },
    restore() {
      cleanup();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

function dialogue({ eventId, line, position }) {
  return {
    type: 'village.dialogue', eventId, lineId: 'ambient-1', speakerId: 'mira',
    speakerName: 'Anna', line, position, timestamp: 100,
  };
}

function response(status = 200) {
  return {
    ok: status === 200,
    status,
    headers: { get: (name) => name === 'content-type' ? 'audio/mpeg' : '12' },
    arrayBuffer: async () => new ArrayBuffer(8),
  };
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('distant resident dialogue neither appears as a subtitle nor starts playback', async () => {
  const fetcher = async () => { fetcher.calls += 1; return response(); };
  fetcher.calls = 0;
  const harness = browserHarness(fetcher);
  try {
    harness.socket.position({ pos: { x: 0, y: 64, z: 0 }, yaw: 0 });
    await harness.elements[1].querySelector('#boson-enable').click();
    harness.eventSource.emit('dialogue', dialogue({ eventId: 'far', line: 'Too far away.', position: { x: 48, y: 64, z: 0 } }));

    const panel = harness.elements[1];
    assert.equal(panel.querySelector('#boson-line').textContent, 'Enable audio to hear nearby residents.');
    assert.equal(fetcher.calls, 0);
    assert.equal(harness.contexts[0].sources.length, 0);
  } finally {
    harness.restore();
  }
});

test('TTS 503, 502, and 429 responses visibly fall back to serialized browser speech', async () => {
  for (const status of [503, 502, 429]) {
    const fetcher = async () => { fetcher.calls += 1; return response(status); };
    fetcher.calls = 0;
    const harness = browserHarness(fetcher);
    try {
      harness.socket.position({ pos: { x: 0, y: 64, z: 0 }, yaw: 0 });
      await harness.elements[1].querySelector('#boson-enable').click();
      harness.eventSource.emit('dialogue', dialogue({ eventId: `fallback-${status}`, line: 'The authored line remains available.', position: { x: 2, y: 64, z: 0 } }));
      await flushPromises();

      assert.equal(fetcher.calls, 1);
      assert.equal(harness.spoken[0]?.text, 'The authored line remains available.');
      assert.match(harness.elements[1].querySelector('#boson-audio-status').textContent, /Degraded.*serialized, non-layered/);
    } finally {
      harness.restore();
    }
  }
});

test('navigation stops active playback, drops queued dialogue, and closes viewer resources', async () => {
  let requests = 0;
  const fetcher = async (_url, { signal }) => {
    requests += 1;
    if (requests === 1) return response();
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new Error('request aborted'));
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, { once: true });
    });
  };
  const harness = browserHarness(fetcher);
  try {
    harness.socket.position({ pos: { x: 0, y: 64, z: 0 }, yaw: 0 });
    await harness.elements[1].querySelector('#boson-enable').click();
    harness.eventSource.emit('dialogue', dialogue({ eventId: 'playing', line: 'Playing now.', position: { x: 1, y: 64, z: 0 } }));
    await flushPromises();
    assert.equal(harness.contexts[0].sources[0]?.started, true);

    for (const id of ['queued-1', 'queued-2', 'queued-3', 'queued-4']) {
      harness.eventSource.emit('dialogue', dialogue({ eventId: id, line: `Queued ${id}.`, position: { x: 2, y: 64, z: 0 } }));
    }
    await flushPromises();
    assert.equal(requests, 4); // Three TTS requests in flight; the fourth dialogue is queued.
    harness.firePageHide();
    await flushPromises(); // Aborted requests pump the client queue as they settle.

    assert.equal(harness.contexts[0].sources[0].stopped, true);
    assert.equal(harness.contexts[0].state, 'closed');
    assert.equal(harness.eventSource.closed, true);
    assert.equal(harness.socket.closed, true);
    assert.equal(harness.cancelCount, 1);
    assert.equal(harness.elements[1].removed, true);
    assert.equal(harness.elements[0].removed, true);
    assert.equal(requests, 4); // Cleanup must clear the queued fourth utterance.
    harness.eventSource.emit('dialogue', dialogue({ eventId: 'after-navigation', line: 'Must not play.', position: { x: 1, y: 64, z: 0 } }));
    await flushPromises();
    assert.equal(requests, 4);
  } finally {
    harness.restore();
  }
});
