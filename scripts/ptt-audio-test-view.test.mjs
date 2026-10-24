import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAudioBenchOutcome } from '../boson-api-demo/ptt-audio-test-view.js';

const limits = { realtimeTurns: 1, ttsRequests: 1 };

test('fresh bounded session offers one test without claiming an outcome', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: { realtimeTurns: 0, lastTurn: null, tts: { requests: 0, characters: 0, succeededRequests: 0, failedRequests: 0, outcomeUnknownRequests: 0 } },
  });

  assert.equal(result.kind, 'ready');
  assert.equal(result.title, 'Ready for one short test');
  assert.match(result.message, /hold P/i);
});

test('consumed session reports fallback semantics separately from successful provider TTS', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 1,
      lastTurn: { status: 'authored_fallback', lineId: 'mira-greeting' },
      tts: { requests: 1, characters: 64, succeededRequests: 1, failedRequests: 0, outcomeUnknownRequests: 0 },
    },
  });

  assert.equal(result.kind, 'complete');
  assert.equal(result.title, 'Test complete');
  assert.match(result.message, /without selecting an accepted authored reply/i);
  assert.match(result.playback, /Provider TTS returned audio.*64 characters/);
  assert.doesNotMatch(result.message + result.playback, /heard/i);
});

test('completed turn with rejected TTS does not report playback success', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 1,
      lastTurn: { status: 'authored_response_selected', playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' },
      tts: { requests: 1, characters: 64, succeededRequests: 0, failedRequests: 1, outcomeUnknownRequests: 0 },
    },
  });

  assert.equal(result.kind, 'complete');
  assert.match(result.message, /selected an authored reply/i);
  assert.match(result.playback, /Provider TTS did not succeed/);
});

test('unknown provider outcome is not reported as either success or failure', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 1,
      lastTurn: { status: 'authored_fallback', lineId: 'mira-greeting' },
      tts: { requests: 1, characters: 64, succeededRequests: 0, failedRequests: 0, outcomeUnknownRequests: 1 },
    },
  });

  assert.match(result.playback, /outcome is unknown/i);
  assert.doesNotMatch(result.playback, /succeeded|did not succeed/i);
});

test('a completed turn with no TTS request does not imply a playback attempt', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 1,
      lastTurn: { status: 'authored_fallback', lineId: 'mira-greeting' },
      tts: { requests: 0, characters: 0, succeededRequests: 0, failedRequests: 0, outcomeUnknownRequests: 0 },
    },
  });

  assert.equal(result.playback, 'No provider TTS request is recorded.');
});

test('an exhausted TTS cap does not claim the Realtime turn was used', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: { realtimeTurns: 0, lastTurn: null, tts: { requests: 1, characters: 64, succeededRequests: 1, failedRequests: 0, outcomeUnknownRequests: 0 } },
  });

  assert.equal(result.kind, 'ready');
  assert.match(result.note, /TTS allowance is used/i);
  assert.match(result.note, /browser fallback/i);
});
