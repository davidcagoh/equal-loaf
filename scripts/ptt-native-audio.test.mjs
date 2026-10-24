import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePcm16Base64Audio,
  estimateRealtimeAudioUsd,
  isNativeRealtimeSessionAck,
  summarizeRealtimeAudioUsage,
} from '../boson-api-demo/ptt-native-audio.js';

test('native output audio decodes little-endian PCM16 into normalized transient samples', () => {
  const bytes = Buffer.alloc(6);
  bytes.writeInt16LE(-32_768, 0);
  bytes.writeInt16LE(16_384, 2);
  bytes.writeInt16LE(32_767, 4);
  const decoded = decodePcm16Base64Audio(bytes.toString('base64'));
  assert.ok(decoded instanceof Float32Array);
  assert.deepEqual(Array.from(decoded), [-1, 0.5, 32_767 / 32_768]);
});

test('invalid, odd-sized, and oversized audio chunks are rejected before playback', () => {
  assert.equal(decodePcm16Base64Audio('not base64'), null);
  assert.equal(decodePcm16Base64Audio(Buffer.from([1]).toString('base64')), null);
  assert.equal(decodePcm16Base64Audio('A'.repeat(256_001)), null);
});

test('provider token usage is reduced to bounded numeric counters', () => {
  assert.deepEqual(summarizeRealtimeAudioUsage({
    total_tokens: 31,
    input_tokens: 20,
    output_tokens: 11,
    input_token_details: { audio_tokens: 18 },
    output_token_details: { audio_tokens: 9 },
    transcript: 'must not be retained',
  }), {
    totalTokens: 31, inputTokens: 20, outputTokens: 11, inputAudioTokens: 18, outputAudioTokens: 9,
  });
  assert.deepEqual(summarizeRealtimeAudioUsage({ total_tokens: -1, input_tokens: 1.5 }), {
    totalTokens: null, inputTokens: null, outputTokens: null, inputAudioTokens: null, outputAudioTokens: null,
  });
  assert.equal(summarizeRealtimeAudioUsage('unsafe'), null);
});

test('native Realtime readiness requires an effective audio-only 24 kHz manual session config', () => {
  const session = {
    output_modalities: ['audio'],
    audio: {
      input: { format: { type: 'audio/pcm', rate: 24_000 }, turn_detection: null },
      output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: 'chloe' },
    },
    tools: [], tool_choice: 'none',
  };
  assert.equal(isNativeRealtimeSessionAck({ type: 'session.created', session }), true);
  assert.equal(isNativeRealtimeSessionAck({ type: 'session.updated', session }), true);
  assert.equal(isNativeRealtimeSessionAck({ type: 'session.created', session: { ...session, output_modalities: ['text'] } }), false);
  assert.equal(isNativeRealtimeSessionAck({ type: 'session.updated', session: { ...session, tools: [{ type: 'function' }] } }), false);
  assert.equal(isNativeRealtimeSessionAck({ type: 'session.updated', session: { ...session, audio: { ...session.audio, input: { ...session.audio.input, turn_detection: { type: 'server_vad' } } } } }), false);
  assert.equal(isNativeRealtimeSessionAck({ type: 'response.done', session }), false);
});

test('published audio-duration estimate computes both directions and does not invent token charges', () => {
  assert.equal(estimateRealtimeAudioUsd(60, 60), 0.0163);
  assert.equal(estimateRealtimeAudioUsd(0, 0), 0);
  assert.equal(estimateRealtimeAudioUsd(Number.NaN, -1), 0);
});
