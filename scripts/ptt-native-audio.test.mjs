import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePcm16Base64Audio,
  estimateRealtimeAudioUsd,
  isNativeRealtimeSessionAck,
  summarizeRealtimeAudioUsage,
} from '../boson-api-demo/ptt-native-audio.js';
import { audioOutputTime, createNativeResponsePlayback } from '../boson-api-demo/native-response-playback.js';

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

test('barge-in cancels an active response then truncates the assistant item at actually played PCM', () => {
  const playback = createNativeResponsePlayback();
  playback.begin('resp_1');
  playback.addChunk('resp_1', { itemId: 'item_1', contentIndex: 0, startAt: 10, duration: 1 });
  playback.addChunk('resp_1', { itemId: 'item_1', contentIndex: 0, startAt: 11, duration: 1 });

  const interruption = playback.interrupt(11.25);
  assert.deepEqual(interruption, { responseId: 'resp_1', cancel: true, truncate: null });
  assert.equal(playback.acceptsAudio('resp_1'), false);
  assert.deepEqual(playback.finish('resp_1'), {
    interrupted: true,
    truncate: { type: 'conversation.item.truncate', item_id: 'item_1', content_index: 0, audio_end_ms: 1_250 },
  });
  assert.deepEqual(playback.finish('resp_1'), { interrupted: true, truncate: null });
});

test('barge-in truncates queued output even after response.done, using only played time', () => {
  const playback = createNativeResponsePlayback();
  playback.begin('resp_2');
  playback.addChunk('resp_2', { itemId: 'item_2', contentIndex: 0, startAt: 20, duration: 2 });
  assert.deepEqual(playback.finish('resp_2'), { interrupted: false, truncate: null });

  assert.deepEqual(playback.interrupt(20.4), {
    responseId: 'resp_2',
    cancel: false,
    truncate: { type: 'conversation.item.truncate', item_id: 'item_2', content_index: 0, audio_end_ms: 400 },
  });
});

test('repeated interruption is idempotent and late audio from canceled responses is ignored', () => {
  const playback = createNativeResponsePlayback();
  playback.begin('resp_3');
  playback.addChunk('resp_3', { itemId: 'item_3', startAt: 30, duration: 1 });
  assert.equal(playback.begin('resp_duplicate'), null);
  playback.interrupt(30.1);
  assert.equal(playback.interrupt(30.2), null);
  playback.finish('resp_3');
  playback.clear('resp_3');
  assert.equal(playback.begin('resp_4').responseId, 'resp_4');
  assert.equal(playback.acceptsAudio('resp_3'), false);
  assert.equal(playback.addChunk('resp_3', { itemId: 'late_item', startAt: 30.2, duration: 1 }), false);
  assert.equal(playback.acceptsAudio('resp_4'), true);
});

test('played-time fallback uses known output latency and never guesses without a timestamp or latency', () => {
  assert.equal(audioOutputTime({ getOutputTimestamp: () => ({ contextTime: 12.5 }), currentTime: 13 }), 12.5);
  assert.equal(audioOutputTime({ currentTime: 13, baseLatency: 0.08, outputLatency: 0.12 }), 12.8);
  assert.equal(audioOutputTime({ currentTime: 13 }), 0);
});
