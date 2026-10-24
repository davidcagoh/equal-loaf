import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAudioBenchOutcome } from '../boson-api-demo/ptt-audio-test-view.js';

const limits = { realtimeTurns: 2, ttsRequests: 2 };

test('fresh bounded session offers two turns without claiming an outcome', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: { realtimeTurns: 0, lastTurn: null, tts: { requests: 0, characters: 0, succeededRequests: 0, failedRequests: 0, outcomeUnknownRequests: 0 } },
  });

  assert.equal(result.kind, 'ready');
  assert.equal(result.title, 'Ready for two short tests');
  assert.match(result.message, /two different requests/i);
});

test('first accepted turn shows safe intent, topic and line before offering the second turn', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 1,
      lastTurn: { status: 'authored_response_selected', playerIntent: 'ask_for_help', topic: 'garden', lineId: 'mira-garden-help' },
      tts: { requests: 1, characters: 27, succeededRequests: 1, failedRequests: 0, outcomeUnknownRequests: 0 },
    },
  });
  assert.equal(result.kind, 'ready');
  assert.equal(result.title, 'One short test remains');
  assert.match(result.message, /ask_for_help · garden · mira-garden-help/);
});

test('consumed session reports fallback semantics separately from successful provider TTS', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 2,
      lastTurn: { status: 'authored_fallback', lineId: 'mira-greeting' },
      tts: { requests: 2, characters: 67, succeededRequests: 2, failedRequests: 0, outcomeUnknownRequests: 0 },
    },
  });

  assert.equal(result.kind, 'complete');
  assert.equal(result.title, 'Test complete');
  assert.match(result.message, /without selecting an accepted authored reply/i);
  assert.match(result.playback, /Provider TTS returned audio.*67 characters/);
  assert.match(result.note, /two-turn allowance/i);
  assert.doesNotMatch(result.message + result.playback, /heard/i);
});

test('final summary retains both bounded semantic selections without dialogue text', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 2,
      lastTurn: { status: 'authored_response_selected', playerIntent: 'ask_for_help', topic: 'garden', lineId: 'mira-garden-help' },
      turnResults: [
        { turnNumber: 1, status: 'authored_response_selected', playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' },
        { turnNumber: 2, status: 'authored_response_selected', playerIntent: 'ask_for_help', topic: 'garden', lineId: 'mira-garden-help' },
      ],
      tts: { requests: 2, characters: 67, succeededRequests: 2, failedRequests: 0, outcomeUnknownRequests: 0 },
    },
  });
  assert.match(result.message, /Turn 1: greet · general · mira-greeting; Turn 2: ask_for_help · garden · mira-garden-help/);
  assert.doesNotMatch(result.message, /Please water|Hello\./);
});

test('completed turn with rejected TTS does not report playback success', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 2,
      lastTurn: { status: 'authored_response_selected', playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' },
      tts: { requests: 2, characters: 67, succeededRequests: 0, failedRequests: 2, outcomeUnknownRequests: 0 },
    },
  });

  assert.equal(result.kind, 'complete');
  assert.match(result.message, /selected greet · general · mira-greeting/i);
  assert.match(result.playback, /Provider TTS did not succeed/);
});

test('unknown provider outcome is not reported as either success or failure', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 2,
      lastTurn: { status: 'authored_fallback', lineId: 'mira-greeting' },
      tts: { requests: 2, characters: 67, succeededRequests: 0, failedRequests: 0, outcomeUnknownRequests: 2 },
    },
  });

  assert.match(result.playback, /outcome is unknown/i);
  assert.doesNotMatch(result.playback, /succeeded|did not succeed/i);
});

test('a completed turn with no TTS request does not imply a playback attempt', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: {
      realtimeTurns: 2,
      lastTurn: { status: 'authored_fallback', lineId: 'mira-greeting' },
      tts: { requests: 0, characters: 0, succeededRequests: 0, failedRequests: 0, outcomeUnknownRequests: 0 },
    },
  });

  assert.equal(result.playback, 'No provider TTS request is recorded.');
});

test('an exhausted TTS cap does not claim the Realtime turn was used', () => {
  const result = deriveAudioBenchOutcome({
    limits,
    usage: { realtimeTurns: 0, lastTurn: null, tts: { requests: 2, characters: 67, succeededRequests: 2, failedRequests: 0, outcomeUnknownRequests: 0 } },
  });

  assert.equal(result.kind, 'ready');
  assert.match(result.note, /TTS allowance is used/i);
  assert.match(result.note, /browser fallback/i);
});
