import assert from 'node:assert/strict';
import test from 'node:test';
import { VillageHeardSpeechMemory } from './village-heard-speech-memory.ts';
import { NativePlayerSpeechHandler } from './village-native-player-speech-handler.ts';
import type { NativePlayerSpeechPositionSample } from './village-player-speech-perception.ts';

const samples: NativePlayerSpeechPositionSample[] = [
  { tick: 1_000, speakerPosition: { x: 0, y: 64, z: 0 }, residents: [
    { residentId: 'mira', position: { x: 4, y: 64, z: 0 } },
    { residentId: 'tobin', position: { x: 7, y: 64, z: 0 } },
    { residentId: 'pip', position: { x: 20, y: 64, z: 0 } },
  ] },
  { tick: 2_000, speakerPosition: { x: 1, y: 64, z: 0 }, residents: [
    { residentId: 'mira', position: { x: 5, y: 64, z: 0 } },
    { residentId: 'tobin', position: { x: 8, y: 64, z: 0 } },
    { residentId: 'pip', position: { x: 21, y: 64, z: 0 } },
  ] },
];

test('production player-speech handler queues only a matching native session and commits nearby memory', () => {
  const memory = new VillageHeardSpeechMemory();
  const handler = new NativePlayerSpeechHandler(memory);
  const turn = { turnId: 'turn-player-1', residentSessionId: 'session-pip-1', playerSpeechSamplingComplete: true, playerSpeechSamples: samples };
  const command = { turnId: turn.turnId, residentSessionId: turn.residentSessionId, itemId: 'item-player-1', transcript: 'The gardens need water.' };
  assert.equal(handler.finish(undefined, command), 'no_session');
  assert.equal(handler.finish({ ...turn, residentSessionId: 'other-session' }, command), 'no_session');
  assert.equal(handler.finish(turn, command), 'queued');
  assert.equal(handler.complete(turn).length, 1);
  assert.deepEqual(memory.recent('mira', 2_000).map(({ text, speakerId }) => [text, speakerId]), [['The gardens need water.', 'player']]);
  assert.deepEqual(memory.recent('tobin', 2_000).map(({ text }) => text), ['The gardens need water.']);
  assert.deepEqual(memory.recent('pip', 2_000), []);
  assert.deepEqual(handler.complete(turn), [], 'completed items are cleared and cannot be projected twice');
});

test('production handler rejects duplicate item IDs and permits a distinct retry item', () => {
  const memory = new VillageHeardSpeechMemory();
  const handler = new NativePlayerSpeechHandler(memory);
  const turn = { turnId: 'turn-player-2', residentSessionId: 'session-pip-1', playerSpeechSamplingComplete: true, playerSpeechSamples: samples };
  const command = { turnId: turn.turnId, residentSessionId: turn.residentSessionId, itemId: 'item-player-2', transcript: 'First claim.' };
  assert.equal(handler.finish(turn, command), 'queued');
  assert.equal(handler.finish(turn, command), 'duplicate');
  assert.equal(handler.finish(turn, { ...command, itemId: 'item-player-2-retry', transcript: 'Retry claim.' }), 'queued');
  assert.equal(handler.complete(turn).length, 2);
  assert.deepEqual(memory.recent('mira', 2_000).map(({ text }) => text), ['First claim.', 'Retry claim.']);
});

test('production handler bounds queued items and discards speech without complete pose coverage', () => {
  const handler = new NativePlayerSpeechHandler(new VillageHeardSpeechMemory(), 1);
  const turn = { turnId: 'turn-player-3', residentSessionId: 'session-pip-1', playerSpeechSamplingComplete: false, playerSpeechSamples: samples };
  const command = { turnId: turn.turnId, residentSessionId: turn.residentSessionId, itemId: 'item-player-3', transcript: 'One item.' };
  assert.equal(handler.finish(turn, command), 'queued');
  assert.equal(handler.finish(turn, { ...command, itemId: 'item-player-4' }), 'too_many');
  assert.deepEqual(handler.complete(turn), []);
  handler.clear();
});
