import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireNativeCapture, decodePcm16Base64Chunk, encodePcm16 } from './native-realtime-core.js';

function base64(bytes: number[]) { return btoa(String.fromCharCode(...bytes)); }

test('empty PCM deltas are no-op and split odd bytes carry across chunks', () => {
  const empty = decodePcm16Base64Chunk('');
  assert.deepEqual({ valid: empty.valid, length: empty.samples?.length, pending: empty.pendingByte }, { valid: true, length: 0, pending: null });
  const left = decodePcm16Base64Chunk(base64([0x00]));
  const noOp = decodePcm16Base64Chunk('', left.pendingByte);
  const right = decodePcm16Base64Chunk(base64([0x40]), noOp.pendingByte);
  assert.equal(noOp.pendingByte, 0);
  assert.deepEqual([...right.samples], [0.5]);
  assert.equal(right.pendingByte, null);
});

test('PCM conversion round trips signed 16-bit samples with little-endian encoding', () => {
  const encoded = encodePcm16(Float32Array.from([-1, 0, 0.5, 1]));
  const decoded = decodePcm16Base64Chunk(encoded);
  assert.deepEqual([...decoded.samples], [-1, 0, 0.499969482421875, 0.999969482421875]);
});

test('capture acquisition stops a late microphone stream after hold generation changes', async () => {
  let current = true;
  let stopped = 0;
  let created = 0;
  const result = await acquireNativeCapture({
    isCurrent: () => current,
    getUserMedia: async () => ({ id: 'stream' }),
    resumeContext: async () => { current = false; },
    prepareWorklet: async () => undefined,
    createCapture: () => { created += 1; return {}; },
    stopStream: () => { stopped += 1; },
    disconnectCapture: () => undefined,
  });
  assert.deepEqual(result, { capture: null, reason: 'capture_cancelled' });
  assert.equal(stopped, 1);
  assert.equal(created, 0);
});
