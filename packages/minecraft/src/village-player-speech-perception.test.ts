import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCompletedPlayerSpeech } from './village-player-speech-perception.ts';
import { buildNativeResidentInstructions } from './native-resident-context.ts';
import { VillageHeardSpeechMemory } from './village-heard-speech-memory.ts';

const base = {
  session: { turnId: 'turn-player-123', sessionId: 'resident-session-123', itemId: 'item_player_1' },
  report: { turnId: 'turn-player-123', sessionId: 'resident-session-123', itemId: 'item_player_1', transcript: 'The gardens need water.' },
  samples: [
    { tick: 1_000, speakerPosition: { x: 0, y: 64, z: 0 }, residents: [
      { residentId: 'mira', position: { x: 4, y: 64, z: 0 } },
      { residentId: 'tobin', position: { x: 8, y: 64, z: 0 } },
      { residentId: 'pip', position: { x: 20, y: 64, z: 0 } },
    ] },
    { tick: 2_000, speakerPosition: { x: 1, y: 64, z: 0 }, residents: [
      { residentId: 'mira', position: { x: 5, y: 64, z: 0 } },
      { residentId: 'tobin', position: { x: 14, y: 64, z: 0 } },
      { residentId: 'pip', position: { x: 20, y: 64, z: 0 } },
    ] },
  ],
};

test('player speech is attributed to the player and reaches only residents continuously in range', () => {
  const event = projectCompletedPlayerSpeech({ ...base, consumedItemIds: new Set() });
  assert.deepEqual(event?.recipientIds, ['mira']);
  assert.equal(event?.speakerId, 'player');
  assert.equal(event?.text, 'The gardens need water.');
  assert.match(String(event?.eventId), /^player-speech:[A-Za-z0-9_-]{32}$/);
  assert.equal(event?.eventId.length! <= 64, true);
});

test('stale, mismatched, duplicate, malformed, and oversized player transcripts are dropped', () => {
  const consumedItemIds = new Set<string>();
  assert.equal(projectCompletedPlayerSpeech({ ...base, report: { ...base.report, turnId: 'other-turn' }, consumedItemIds }), null);
  assert.equal(projectCompletedPlayerSpeech({ ...base, report: { ...base.report, sessionId: 'other-session' }, consumedItemIds }), null);
  assert.equal(projectCompletedPlayerSpeech({ ...base, report: { ...base.report, itemId: 'other-item' }, consumedItemIds }), null);
  assert.ok(projectCompletedPlayerSpeech({ ...base, consumedItemIds }));
  assert.equal(projectCompletedPlayerSpeech({ ...base, consumedItemIds }), null);
  assert.equal(projectCompletedPlayerSpeech({ ...base, report: { ...base.report, transcript: 'x'.repeat(1_001) }, consumedItemIds: new Set() }), null);
  assert.equal(projectCompletedPlayerSpeech({ ...base, samples: base.samples.slice(0, 1), consumedItemIds: new Set() }), null);
});

test('player position and listener positions must remain authoritative and finite', () => {
  const badSource = [{ ...base.samples[0]!, speakerPosition: { x: Infinity, y: 64, z: 0 } }, base.samples[1]!];
  assert.equal(projectCompletedPlayerSpeech({ ...base, samples: badSource, consumedItemIds: new Set() }), null);
});

test('eligible next resident prompt receives its own attributed player claim only', () => {
  const now = Date.now();
  const event = projectCompletedPlayerSpeech({
    ...base,
    samples: base.samples.map((sample, index) => ({ ...sample, tick: now + index })),
    consumedItemIds: new Set(),
  });
  assert.ok(event);
  const memory = new VillageHeardSpeechMemory();
  memory.remember(event, 'the player');
  const prompt = (id: string, name: string) => buildNativeResidentInstructions({
    id, name, role: 'villager', goal: 'keep the village well', locationId: 'market-well', topics: [], facts: [],
    responseOptions: [], relationship: 'unfamiliar', recentHeardSpeech: memory.recent(id),
  });
  assert.match(prompt('mira', 'Anna'), /the player said: “The gardens need water\.”/);
  assert.doesNotMatch(prompt('tobin', 'James'), /The gardens need water/);
  assert.doesNotMatch(prompt('pip', 'Thomas'), /The gardens need water/);
});
