import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement {
  id = '';
  textContent = '';
  disabled = false;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  children: FakeElement[] = [];
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, callback: (event: Record<string, unknown>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  setPointerCapture() {}
  fire(name: string, event: Record<string, unknown> = {}) {
    for (const callback of this.listeners.get(name) ?? []) callback({ preventDefault() {}, pointerId: 1, code: 'Space', ...event });
  }
}

const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

async function setupBrowser(
  getUserMedia: () => Promise<unknown>,
  fetcher: typeof fetch,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout, clearTimeout },
) {
  const elements: FakeElement[] = [];
  const documentStub = {
    head: new FakeElement(),
    body: new FakeElement(),
    visibilityState: 'visible',
    createElement: () => { const element = new FakeElement(); elements.push(element); return element; },
    addEventListener() {},
  };
  const windowStub = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    addEventListener() {},
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowStub });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia } },
  });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetcher });
  return { documentStub, elements };
}

test('held PTT release before permission resolves stops the late microphone stream without starting a turn', async () => {
  let allowMic!: (stream: unknown) => void;
  let tracksStopped = 0;
  const fetchCalls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return { ok: true, json: async () => ({ available: true }) } as Response;
  }) as typeof fetch;
  const { elements } = await setupBrowser(() => new Promise((resolve) => { allowMic = resolve; }), fetcher);
  const module = await import('./viewer-ptt.js?permission-test');
  await tick();
  const button = elements.find((element) => element.textContent === 'Hold to talk');
  assert.ok(button);
  button.fire('pointerdown');
  button.fire('pointerup');
  allowMic({ getTracks: () => [{ stop: () => { tracksStopped += 1; } }] });
  await tick();
  assert.equal(tracksStopped, 1);
  assert.deepEqual(fetchCalls, ['/boson-ptt/status']);
  assert.equal(button.attributes.get('aria-pressed'), 'false');
  void module;
});

test('PTT sends audio only during hold and requests a text-only tool-free response', async () => {
  const fetchCalls: Array<{ path: string; payload?: unknown }> = [];
  const holdTimeouts: Array<() => void> = [];
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks };
  const fetcher = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    const payload = options?.body ? JSON.parse(String(options.body)) : undefined;
    fetchCalls.push({ path, payload });
    const result = path === '/boson-ptt/status' ? { available: true }
      : path === '/boson-ptt/begin' ? {
        available: true,
        turnId: 'turn-1',
        clientSecret: 'bai-eph-short-lived',
        instructions: 'return bounded json',
        allowedLineIds: ['mira-greeting'],
      }
        : { accepted: true };
    return { ok: true, json: async () => result } as Response;
  }) as typeof fetch;
  const { elements } = await setupBrowser(async () => stream, fetcher, {
    setTimeout: ((callback: TimerHandler) => { holdTimeouts.push(callback as () => void); return 1 as never; }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  class FakeAudioContext {
    state = 'running';
    audioWorklet = { addModule: async () => undefined };
    destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }
  class FakeWorklet {
    port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null };
    connect() {}
    disconnect() {}
  }
  let socket: FakeWebSocket | undefined;
  let worklet: FakeWorklet | undefined;
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
    constructor() { socket = this; }
    addEventListener(name: string, callback: (event: { data?: unknown }) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
    }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = FakeWebSocket.CLOSING; }
    fire(name: string, event: { data?: unknown } = {}) { for (const callback of this.listeners.get(name) ?? []) callback(event); }
    open() { this.readyState = FakeWebSocket.OPEN; this.fire('open'); }
  }
  const AudioWorkletNodeStub = class extends FakeWorklet {
    constructor() { super(); worklet = this; }
  };
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: AudioWorkletNodeStub });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket });
  const module = await import('./viewer-ptt.js?text-only-test');
  await tick();
  const button = elements.find((element) => element.textContent === 'Hold to talk');
  assert.ok(button);
  button.fire('pointerdown');
  await tick();
  await tick();
  assert.ok(socket);
  socket.open();
  socket.fire('message', { data: JSON.stringify({ type: 'session.created' }) });
  await tick();
  await tick();
  assert.ok(worklet?.port.onmessage);
  worklet.port.onmessage({ data: new Float32Array(960).fill(0.1) });
  assert.equal(socket.sent.some((event) => event.type === 'input_audio_buffer.append'), true);
  holdTimeouts[0]?.();
  assert.equal(socket.sent.some((event) => event.type === 'input_audio_buffer.commit'), true);
  socket.fire('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed' }) });
  const sessionUpdate = socket.sent.find((event) => event.type === 'session.update');
  assert.deepEqual((sessionUpdate?.session as Record<string, unknown>).output_modalities, ['text']);
  assert.deepEqual((sessionUpdate?.session as Record<string, unknown>).tools, []);
  assert.equal(socket.sent.some((event) => event.type === 'response.create'), true);
  socket.fire('message', { data: JSON.stringify({
    type: 'response.output_text.delta',
        delta: JSON.stringify({ playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' }),
  }) });
  socket.fire('message', { data: JSON.stringify({ type: 'response.done' }) });
  await tick();
  assert.equal(fetchCalls.some(({ path }) => path === '/boson-ptt/begin'), true);
  assert.equal(fetchCalls.some(({ path, payload }) => path === '/boson-ptt/complete'
    && (payload as { response?: unknown }).response !== undefined), true);
  assert.equal(tracks[0].stopped, true);
  void module;
});
