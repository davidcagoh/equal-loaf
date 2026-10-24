import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCompletedResidentSpeech } from './village-spoken-perception.ts';

const sample = (tick: number, changes: Record<string, { x: number; y: number; z: number }> = {}) => ({
  tick,
  speakerPosition: { x: 0, y: 64, z: 0 },
  residents: [
    { residentId: 'mira', position: changes.mira ?? { x: 8, y: 64, z: 0 } },
    { residentId: 'pip', position: { x: 0, y: 64, z: 0 } },
    { residentId: 'tobin', position: changes.tobin ?? { x: 13, y: 64, z: 0 } },
  ],
});

function project(overrides: Partial<Parameters<typeof projectCompletedResidentSpeech>[0]> = {}) {
  return projectCompletedResidentSpeech({
    session: { sessionId: 'session-a', speakerId: 'pip', responseId: 'response-1' },
    playbackReport: { sessionId: 'session-a', responseId: 'response-1', transcript: 'The west path is flooded.', playback: 'completed' },
    samples: [sample(10), sample(20)], consumedResponseIds: new Set(), ...overrides,
  });
}

test('projects completed speech only to non-speakers who stayed inside engine hearing range', () => {
  const consumedResponseIds = new Set<string>();
  const event = project({ consumedResponseIds });

  assert.deepEqual(event?.recipientIds, ['mira']);
  assert.equal(event?.speakerId, 'pip');
  assert.equal(event?.text, 'The west path is flooded.');
  assert.equal(event?.startedAtTick, 10);
  assert.equal(event?.completedAtTick, 20);
  assert.deepEqual([...consumedResponseIds], ['session-a:response-1']);
});

test('a resident entering or leaving range during playback does not receive the whole utterance', () => {
  assert.equal(project({ samples: [sample(10), sample(20, { mira: { x: 14, y: 64, z: 0 } })] }), null);
  assert.equal(project({ samples: [sample(10, { tobin: { x: 10, y: 64, z: 0 } }), sample(20)] })?.recipientIds.includes('tobin'), false);
});

test('interrupted, duplicate, malformed, and oversized transcript projections are dropped', () => {
  const consumedResponseIds = new Set<string>();
  assert.equal(project({ playbackReport: { sessionId: 'session-a', responseId: 'response-1', transcript: 'The west path is flooded.', playback: 'interrupted' }, consumedResponseIds }), null);
  assert.equal(project({ consumedResponseIds }), null, 'a response is consumed once, including interruption');
  assert.equal(project({ playbackReport: { sessionId: 'session-a', responseId: 'response-1', transcript: '   ', playback: 'completed' } }), null);
  assert.equal(project({ playbackReport: { sessionId: 'session-a', responseId: 'response-1', transcript: 'x'.repeat(4_097), playback: 'completed' } }), null);
  assert.equal(project({ playbackReport: { sessionId: 'client-selected speaker', responseId: 'response-1', transcript: 'spoof', playback: 'completed' } }), null);
});

test('speaker identity comes only from the server-resolved session record', () => {
  const event = project({ session: { sessionId: 'session-a', speakerId: 'mira', responseId: 'response-1' } });
  assert.equal(event?.speakerId, 'mira');
  assert.equal(event?.recipientIds.includes('mira'), false);
});

test('response deduplication state stays bounded for persistent resident sessions', () => {
  const consumedResponseIds = new Set(Array.from({ length: 512 }, (_, index) => `old-session:response-${index}`));
  project({ consumedResponseIds });

  assert.equal(consumedResponseIds.size, 512);
  assert.equal(consumedResponseIds.has('old-session:response-0'), false);
  assert.equal(consumedResponseIds.has('session-a:response-1'), true);
});
