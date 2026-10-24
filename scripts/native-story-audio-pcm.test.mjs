import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePcm16Base64Chunk, pcmRemainderKey } from '../boson-api-demo/native-story-audio.js';

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

test('an empty provider audio delta is a valid no-op', () => {
  const decoded = decodePcm16Base64Chunk('');
  assert.deepEqual({ valid: decoded.valid, length: decoded.samples?.length, pendingByte: decoded.pendingByte, decodedBytes: decoded.decodedBytes }, {
    valid: true, length: 0, pendingByte: null, decodedBytes: 0,
  });
});

test('PCM remainder keys preserve tuple boundaries and null IDs', () => {
  assert.notEqual(pcmRemainderKey('a:b', 'c', 0), pcmRemainderKey('a', 'b:c', 0));
  assert.notEqual(pcmRemainderKey('response', null, 0), pcmRemainderKey('response', 'unknown', 0));
});

test('PCM16 samples split across odd byte boundaries are reconstructed without loss', () => {
  const first = decodePcm16Base64Chunk(base64([0x00, 0x40, 0xff]));
  const second = decodePcm16Base64Chunk(base64([0x7f, 0x00]), first.pendingByte);
  const third = decodePcm16Base64Chunk(base64([0x00]), second.pendingByte);

  assert.equal(first.valid, true);
  assert.deepEqual([...first.samples], [0.5]);
  assert.equal(first.pendingByte, 0xff);
  assert.equal(second.valid, true);
  assert.deepEqual([...second.samples], [0.999969482421875]);
  assert.equal(second.pendingByte, 0);
  assert.deepEqual([...third.samples], [0]);
  assert.equal(third.pendingByte, null);
});

test('empty deltas preserve a pending byte until its matching continuation arrives', () => {
  const first = decodePcm16Base64Chunk(base64([0x00]));
  const empty = decodePcm16Base64Chunk('', first.pendingByte);
  const last = decodePcm16Base64Chunk(base64([0x40]), empty.pendingByte);

  assert.equal(first.pendingByte, 0);
  assert.equal(empty.pendingByte, 0);
  assert.equal(empty.samples.length, 0);
  assert.deepEqual([...last.samples], [0.5]);
  assert.equal(last.pendingByte, null);
});

test('corrupt base64 and oversized deltas remain rejected with safe size metadata', () => {
  const corrupt = decodePcm16Base64Chunk('A===');
  const oversized = decodePcm16Base64Chunk('A'.repeat(256_001));

  assert.equal(corrupt.valid, false);
  assert.equal(corrupt.reason, 'malformed_base64');
  assert.equal(corrupt.decodedBytes, null);
  assert.equal(corrupt.encodedChars, 4);
  assert.equal(oversized.valid, false);
  assert.equal(oversized.reason, 'encoded_too_large');
  assert.equal(oversized.decodedBytes, null);
  assert.equal(oversized.encodedChars, 256_001);
});
