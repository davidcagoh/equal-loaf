import assert from 'node:assert/strict';
import test from 'node:test';
import { VillageHeardSpeechMemory } from './village-heard-speech-memory.ts';
import type { TransientResidentSpeechPerception } from './village-spoken-perception.ts';
import type { TransientPlayerSpeechPerception } from './village-player-speech-perception.ts';

const event = (eventId: string, text: string, tick: number): TransientResidentSpeechPerception => ({
  type: 'resident.speech.perceived', eventId, speakerId: 'pip', responseId: eventId, text,
  recipientIds: ['mira', 'tobin'], startedAtTick: tick - 10, completedAtTick: tick,
});

test('resident hearsay stays attributed, private to eligible recipients, bounded, and short lived', () => {
  const memory = new VillageHeardSpeechMemory(2, 100);
  assert.equal(memory.remember(event('e1', 'One claimed fact.', 10), 'Thomas'), 2);
  memory.remember(event('e2', 'A second claim.', 20), 'Thomas');
  memory.remember(event('e3', 'A third claim.', 30), 'Thomas');

  assert.deepEqual(memory.recent('mira', 50).map(({ speakerName, text }) => [speakerName, text]), [
    ['Thomas', 'A second claim.'], ['Thomas', 'A third claim.'],
  ]);
  assert.deepEqual(memory.recent('tobin', 50).map(({ eventId }) => eventId), ['e2', 'e3']);
  assert.deepEqual(memory.recent('pip', 50), [], 'a speaker never hears their own speech through this path');
  assert.equal(memory.recent('mira', 131).length, 0, 'expired raw text is removed when memory is read');

  memory.remember(event('e4', 'Short lived.', 150), 'Thomas');
  memory.clear();
  assert.deepEqual(memory.recent('mira', 150), []);
});

test('player speech becomes private attributed memory for each eligible resident', () => {
  const memory = new VillageHeardSpeechMemory();
  const now = Date.now();
  const playerEvent: TransientPlayerSpeechPerception = {
    type: 'player.speech.perceived', eventId: 'session:turn:item', speakerId: 'player',
    text: 'The gardens need water.', recipientIds: ['mira', 'tobin'], startedAtTick: now - 1, completedAtTick: now,
  };
  assert.equal(memory.remember(playerEvent, 'the player'), 2);
  assert.deepEqual(memory.recent('mira').map(({ speakerId, speakerName, text }) => [speakerId, speakerName, text]), [
    ['player', 'the player', 'The gardens need water.'],
  ]);
  assert.deepEqual(memory.recent('tobin').map(({ eventId }) => eventId), ['session:turn:item']);
  assert.deepEqual(memory.recent('pip'), []);
});
