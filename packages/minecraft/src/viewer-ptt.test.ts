import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendBoundedPttText,
  evaluateCompletedPttResponse,
  isBoundedPttLineIdList,
  parseCompletedPttResponse,
  recordSingleTerminalPttText,
} from './viewer-ptt.js';

const allowedLineIds = ['mira-greeting'];
const boundedResponse = JSON.stringify({ playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' });

test('line ID allowlist accepts bounded scene dots and rejects malformed, duplicate, or oversized IDs', () => {
  assert.equal(isBoundedPttLineIdList(['equal-loaf.thomas.welcome', 'equal-loaf.anna.garden-workers']), true);
  assert.equal(isBoundedPttLineIdList(['x'.repeat(128)]), true);
  assert.equal(isBoundedPttLineIdList(['x'.repeat(129)]), false);
  assert.equal(isBoundedPttLineIdList(['line/id']), false);
  assert.equal(isBoundedPttLineIdList(['duplicate', 'duplicate']), false);
  assert.equal(isBoundedPttLineIdList([]), false);
  assert.equal(isBoundedPttLineIdList(Array(33).fill('line')), false);
});

test('oversized provider deltas are rejected before being retained and remain rejected', () => {
  const asciiOverflow = appendBoundedPttText('', 'x'.repeat(2_001));
  const unicodeOverflow = appendBoundedPttText('', '🗣'.repeat(501));
  const afterOverflow = appendBoundedPttText('', boundedResponse, true);

  assert.deepEqual(asciiOverflow, { text: '', rejected: true });
  assert.deepEqual(unicodeOverflow, { text: '', rejected: true });
  assert.deepEqual(afterOverflow, { text: '', rejected: true });
});

test('completed terminal text replaces accumulated deltas without duplicate content', () => {
  const parsed = parseCompletedPttResponse({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: boundedResponse }] }],
    },
  }, `${boundedResponse}${boundedResponse}`, boundedResponse, allowedLineIds);

  assert.deepEqual(parsed, { playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' });
});

test('completed final-only response output text is parsed without delta events', () => {
  const parsed = parseCompletedPttResponse({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: boundedResponse }] }],
    },
  }, '', null, allowedLineIds);

  assert.deepEqual(parsed, { playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' });
});

test('terminal output_text.done is used when response.done has no output array', () => {
  const parsed = parseCompletedPttResponse({ type: 'response.done', response: { status: 'completed' } }, '', boundedResponse, allowedLineIds);

  assert.deepEqual(parsed, { playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' });
});

test('multiple terminal text parts are rejected when final response output is absent', () => {
  const outcome = evaluateCompletedPttResponse(
    { type: 'response.done', response: { status: 'completed' } },
    '', boundedResponse, allowedLineIds, 2,
  );

  assert.equal(outcome.response, null);
  assert.equal(outcome.rejectionReason, 'response_text_multiple_parts');
});

test('response output text parts and item arrays are bounded', () => {
  const repeatedText = evaluateCompletedPttResponse({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: boundedResponse },
        { type: 'output_text', text: boundedResponse },
      ] }],
    },
  }, '', null, allowedLineIds);
  const oversizedOutput = evaluateCompletedPttResponse({
    type: 'response.done',
    response: { status: 'completed', output: Array(33).fill({ type: 'message', role: 'assistant', content: [] }) },
  }, '', null, allowedLineIds);
  const oversizedText = evaluateCompletedPttResponse({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ' '.repeat(2_001) }] }],
    },
  }, '', null, allowedLineIds);

  assert.equal(repeatedText.rejectionReason, 'response_text_multiple_parts');
  assert.equal(oversizedOutput.rejectionReason, 'response_output_too_large');
  assert.equal(oversizedText.rejectionReason, 'response_text_too_large');
});

test('only one terminal text part is retained', () => {
  const first = recordSingleTerminalPttText(0, boundedResponse);
  const second = recordSingleTerminalPttText(first.count, boundedResponse);

  assert.deepEqual(first, { text: boundedResponse, count: 1, rejectionReason: null });
  assert.deepEqual(second, { text: null, count: 2, rejectionReason: 'response_text_multiple_parts' });
});

test('malformed and oversized terminal text remain rejected', () => {
  const completed = { type: 'response.done', response: { status: 'completed' } };

  assert.equal(parseCompletedPttResponse(completed, '', '{bad json', allowedLineIds), null);
  assert.equal(parseCompletedPttResponse(completed, '', ' '.repeat(2_001), allowedLineIds), null);
});

test('failed or incomplete responses cannot accept parseable partial deltas', () => {
  for (const status of ['failed', 'incomplete', 'cancelled']) {
    const outcome = evaluateCompletedPttResponse({ type: 'response.done', response: { status } }, boundedResponse, null, allowedLineIds);
    assert.equal(outcome.response, null);
    assert.equal(outcome.rejectionReason, 'response_status_not_completed');
  }
});

test('fallback classification uses safe reason codes and never returns provider text', () => {
  const completed = { type: 'response.done', response: { status: 'completed' } };
  const missing = evaluateCompletedPttResponse(completed, '', null, allowedLineIds);
  const invalidJson = evaluateCompletedPttResponse(completed, '', '{bad json', allowedLineIds);
  const oversized = evaluateCompletedPttResponse(completed, '', ' '.repeat(2_001), allowedLineIds);
  const rejectedSchema = evaluateCompletedPttResponse(completed, '', JSON.stringify({ playerIntent: 'greet', topic: 'secret-topic', lineId: 'mira-greeting' }), allowedLineIds);

  assert.equal(missing.rejectionReason, 'response_text_missing');
  assert.equal(invalidJson.rejectionReason, 'response_json_invalid');
  assert.equal(oversized.rejectionReason, 'response_text_too_large');
  assert.equal(rejectedSchema.rejectionReason, 'response_schema_rejected');
  for (const outcome of [missing, invalidJson, oversized, rejectedSchema]) {
    assert.equal('text' in outcome, false);
  }
});

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
  const documentListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const windowListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const fire = (listeners: Map<string, Array<(event: Record<string, unknown>) => void>>, name: string, event: Record<string, unknown> = {}) => {
    for (const callback of listeners.get(name) ?? []) callback({ preventDefault() {}, ...event });
  };
  const documentStub = {
    head: new FakeElement(),
    body: new FakeElement(),
    documentElement: new FakeElement(),
    activeElement: null as unknown,
    pointerLockElement: null as unknown,
    visibilityState: 'visible',
    createElement: () => { const element = new FakeElement(); elements.push(element); return element; },
    addEventListener(name: string, callback: (event: Record<string, unknown>) => void) {
      documentListeners.set(name, [...(documentListeners.get(name) ?? []), callback]);
    },
  };
  const windowStub = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    addEventListener(name: string, callback: (event: Record<string, unknown>) => void) {
      windowListeners.set(name, [...(windowListeners.get(name) ?? []), callback]);
    },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowStub });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia } },
  });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetcher });
  return {
    documentStub,
    elements,
    fireDocument: (name: string, event?: Record<string, unknown>) => fire(documentListeners, name, event),
    fireWindow: (name: string, event?: Record<string, unknown>) => fire(windowListeners, name, event),
  };
}

test('P starts one held turn from the lab surface and keyup releases it while begin is pending', async () => {
  let micCalls = 0;
  let tracksStopped = 0;
  let beginCalls = 0;
  let cancelCalls = 0;
  let allowBegin!: (response: Response) => void;
  const fetcher = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/boson-ptt/status') return Response.json({ available: true });
    if (path === '/boson-ptt/begin') {
      beginCalls += 1;
      return new Promise<Response>((resolve) => { allowBegin = resolve; });
    }
    if (path === '/boson-ptt/cancel') { cancelCalls += 1; return Response.json({ cancelled: true }); }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  const { documentStub, elements, fireDocument } = await setupBrowser(async () => {
    micCalls += 1;
    return { getTracks: () => [{ stop: () => { tracksStopped += 1; } }] };
  }, fetcher);
  await import('./viewer-ptt.js?keyboard-hold-p-pending-begin');
  await tick();
  assert.equal(elements.find((element) => element.id === 'boson-ptt')?.children[1].textContent, 'Hold P to talk');

  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, repeat: false });
  await tick();
  await tick();
  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, repeat: true });
  assert.equal(micCalls, 1);
  assert.equal(beginCalls, 1, 'autorepeat cannot send duplicate begin requests');

  fireDocument('keyup', { code: 'KeyP', target: documentStub.body });
  await tick();
  assert.equal(tracksStopped, 1, 'keyup stops capture while server begin is pending');
  assert.equal(elements.find((element) => element.id === 'boson-ptt-status')?.textContent, 'Turn cancelled before audio started.');
  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, repeat: false });
  fireDocument('keyup', { code: 'KeyP', target: documentStub.body });
  assert.equal(micCalls, 1, 'another P tap cannot overlap an unresolved begin request');
  assert.equal(beginCalls, 1);

  allowBegin(Response.json({
    available: true,
    turnId: 'late-turn',
    clientSecret: 'bai-eph-short-lived',
    instructions: 'return bounded json',
    allowedLineIds: ['mira-greeting'],
  }));
  await tick();
  await tick();
  assert.equal(cancelCalls, 1, 'late begin response is cancelled once');
  assert.equal(micCalls, 1);
});

test('P shortcut ignores editing targets, modifiers and repeats; blur releases pending microphone access', async () => {
  let micCalls = 0;
  let beginCalls = 0;
  let allowMic!: (stream: unknown) => void;
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input) === '/boson-ptt/status') return Response.json({ available: true });
    if (String(input) === '/boson-ptt/begin') beginCalls += 1;
    return Response.json({ available: true });
  }) as typeof fetch;
  const { documentStub, elements, fireDocument, fireWindow } = await setupBrowser(
    () => { micCalls += 1; return new Promise((resolve) => { allowMic = resolve; }); }, fetcher,
  );
  await import('./viewer-ptt.js?keyboard-hold-p-guards');
  await tick();

  const input = { tagName: 'INPUT', isContentEditable: false };
  fireDocument('keydown', { code: 'KeyP', target: input, repeat: false });
  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, ctrlKey: true, repeat: false });
  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, metaKey: true, repeat: false });
  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, altKey: true, repeat: false });
  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, shiftKey: true, repeat: false });
  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, repeat: true });
  assert.equal(micCalls, 0, 'unrelated editing and modified/repeated keys do not request microphone');

  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, repeat: false });
  assert.equal(micCalls, 1);
  fireWindow('blur');
  fireWindow('keyup', { code: 'KeyP', target: documentStub.body });
  allowMic({ getTracks: () => [{ stop() {} }] });
  await tick();
  await tick();
  assert.equal(beginCalls, 0, 'late microphone permission after blur never begins a provider turn');
  assert.equal(elements.find((element) => element.id === 'boson-ptt')?.children[1].attributes.get('aria-pressed'), 'false');
});

test('hidden-page change releases a P hold before late microphone permission resolves', async () => {
  let allowMic!: (stream: unknown) => void;
  let beginCalls = 0;
  let tracksStopped = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input) === '/boson-ptt/status') return Response.json({ available: true });
    if (String(input) === '/boson-ptt/begin') beginCalls += 1;
    return Response.json({ available: true });
  }) as typeof fetch;
  const { documentStub, fireDocument } = await setupBrowser(
    () => new Promise((resolve) => { allowMic = resolve; }), fetcher,
  );
  await import('./viewer-ptt.js?keyboard-hold-p-hidden');
  await tick();
  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, repeat: false });
  documentStub.visibilityState = 'hidden';
  fireDocument('visibilitychange');
  allowMic({ getTracks: () => [{ stop: () => { tracksStopped += 1; } }] });
  await tick();
  await tick();
  assert.equal(beginCalls, 0);
  assert.equal(tracksStopped, 1);
});

test('microphone permission failures report a safe actionable reason without raw exception details', async () => {
  const fetcher = (async () => Response.json({ available: true })) as typeof fetch;
  const { elements, documentStub, fireDocument } = await setupBrowser(async () => {
    throw new DOMException('Denied by user secret-bearing browser detail', 'NotAllowedError');
  }, fetcher);
  await import('./viewer-ptt.js?keyboard-hold-p-permission-error');
  await tick();
  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, repeat: false });
  await tick();
  const status = elements.find((element) => element.id === 'boson-ptt-status')?.textContent ?? '';
  assert.match(status, /Microphone permission was denied/);
  assert.doesNotMatch(status, /secret-bearing|Denied by user/);
  const button = elements.find((element) => element.textContent === 'Hold P to talk');
  assert.equal(button?.attributes.get('aria-pressed'), 'false', 'failed permission startup restores idle control state');
});

test('rejected local begin stops the mic, clears pressed state and allows a retry', async () => {
  let beginCalls = 0;
  let stopCalls = 0;
  let clearTimeoutCalls = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input) === '/boson-ptt/status') return Response.json({ available: true });
    if (String(input) === '/boson-ptt/begin') {
      beginCalls += 1;
      return Response.json({ available: false, error: 'Boson voice is not configured; local village audio remains available.' }, { status: 503 });
    }
    return Response.json({ cancelled: true });
  }) as typeof fetch;
  const { documentStub, elements, fireDocument } = await setupBrowser(async () => ({
    getTracks: () => [{ stop: () => { stopCalls += 1; } }],
  }), fetcher, {
    setTimeout: (() => 7 as never) as typeof setTimeout,
    clearTimeout: (() => { clearTimeoutCalls += 1; }) as typeof clearTimeout,
  });
  await import('./viewer-ptt.js?keyboard-begin-rejection-reset');
  await tick();
  const button = elements.find((element) => element.id === 'boson-ptt')?.children[1];
  assert.ok(button);

  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, repeat: false });
  await tick();
  await tick();
  assert.equal(stopCalls, 1);
  assert.equal(button.attributes.get('aria-pressed'), 'false');
  assert.equal(button.textContent, 'Hold P to talk');
  assert.equal(clearTimeoutCalls, 1);
  assert.match(elements.find((element) => element.id === 'boson-ptt-status')?.textContent ?? '', /Boson voice is not configured/);

  fireDocument('keydown', { code: 'KeyP', target: documentStub.body, repeat: false });
  await tick();
  await tick();
  assert.equal(beginCalls, 2, 'a rejected begin does not leave the client unable to retry');
  assert.equal(button.attributes.get('aria-pressed'), 'false');
});

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
  const button = elements.find((element) => element.textContent === 'Hold P to talk');
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
        : { accepted: true, status: 'accepted' };
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
  const button = elements.find((element) => element.textContent === 'Hold P to talk');
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
  const finalText = JSON.stringify({ playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' });
  socket.fire('message', { data: JSON.stringify({ type: 'response.output_text.done', text: finalText }) });
  socket.fire('message', { data: JSON.stringify({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText }] }],
    },
  }) });
  await tick();
  assert.equal(fetchCalls.some(({ path }) => path === '/boson-ptt/begin'), true);
  const completionCalls = fetchCalls.filter(({ path }) => path === '/boson-ptt/complete');
  assert.equal(completionCalls.length, 1);
  assert.deepEqual((completionCalls[0].payload as { response: unknown }).response, {
    playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting',
  });
  assert.equal(tracks[0].stopped, true);
  void module;
});
