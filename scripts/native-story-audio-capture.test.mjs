import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireNativeCapture, createRetryableWorkletLoader, nativeCaptureFailureReason } from '../boson-api-demo/native-story-audio.js';

function fakeStream() {
  const track = { stops: 0, stop() { this.stops += 1; } };
  return { track, stream: { getTracks: () => [track] } };
}

function captureOptions({ current, getUserMedia, prepareWorklet = async () => {}, createCapture = (stream) => ({ stream }), cleanup = () => {} }) {
  return {
    isCurrent: current,
    getUserMedia,
    resumeContext: async () => {},
    prepareWorklet,
    createCapture,
    stopStream: (stream) => stream.getTracks().forEach((track) => track.stop()),
    disconnectCapture: cleanup,
  };
}

test('release then repress invalidates the older pending microphone request and stops its late stream', async () => {
  let generation = 1;
  let resolveFirst;
  const firstStream = fakeStream();
  const secondStream = fakeStream();
  let created = 0;
  const first = acquireNativeCapture(captureOptions({
    current: () => generation === 1,
    getUserMedia: () => new Promise((resolve) => { resolveFirst = resolve; }),
    createCapture: (stream) => { created += 1; return { stream }; },
  }));

  generation = 2; // release invalidates hold one; hold two now owns capture
  const second = await acquireNativeCapture(captureOptions({
    current: () => generation === 2,
    getUserMedia: async () => secondStream.stream,
    createCapture: (stream) => { created += 1; return { stream }; },
  }));
  resolveFirst(firstStream.stream);

  assert.equal((await first).reason, 'capture_cancelled');
  assert.equal(firstStream.track.stops, 1);
  assert.equal(secondStream.track.stops, 0);
  assert.equal(created, 1);
  assert.equal(second.capture.stream, secondStream.stream);
});

test('release while worklet loading stops the stream and never creates a capture graph', async () => {
  let generation = 7;
  let resolveWorklet;
  const stream = fakeStream();
  let created = false;
  const result = acquireNativeCapture(captureOptions({
    current: () => generation === 7,
    getUserMedia: async () => stream.stream,
    prepareWorklet: () => new Promise((resolve) => { resolveWorklet = resolve; }),
    createCapture: () => { created = true; return {}; },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  generation = 8;
  resolveWorklet();

  assert.deepEqual(await result, { capture: null, reason: 'capture_cancelled' });
  assert.equal(stream.track.stops, 1);
  assert.equal(created, false);
});

test('rejected worklet loading can retry without reusing its rejected promise', async () => {
  let attempts = 0;
  const load = createRetryableWorkletLoader(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('private provider or browser detail');
    return 'ready';
  });

  await assert.rejects(load(), /private provider or browser detail/);
  assert.equal(await load(), 'ready');
  assert.equal(await load(), 'ready');
  assert.equal(attempts, 2);
});

test('capture failures expose only safe stage and browser error enums', () => {
  assert.equal(nativeCaptureFailureReason('microphone', { name: 'NotAllowedError', message: 'private' }), 'microphone_permission_denied');
  assert.equal(nativeCaptureFailureReason('microphone', { name: 'NotReadableError' }), 'microphone_device_busy');
  assert.equal(nativeCaptureFailureReason('worklet', new Error('sensitive raw detail')), 'audio_worklet_unavailable');
  assert.equal(nativeCaptureFailureReason('capture_graph', new Error('sensitive raw detail')), 'capture_graph_unavailable');
});
