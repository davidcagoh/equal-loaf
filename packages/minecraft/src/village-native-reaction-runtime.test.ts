import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVillageResidentPositionSnapshot,
  NativeResidentReactionRuntime,
  RESIDENT_POSITION_SNAPSHOT_INTERVAL_MS,
  startResidentPositionSnapshotHeartbeat,
  type NativeReactionRuntimeEvent,
} from './village-native-reaction-runtime.ts';

function createHarness() {
  let now = 10_000;
  const emitted: NativeReactionRuntimeEvent[] = [];
  const remembered: Array<{ eventId: string; speakerName: string }> = [];
  const runtime = new NativeResidentReactionRuntime({
    now: () => now,
    emitEngineEvent: (event) => emitted.push(event),
    samplePlayback: (speakerId) => ({
      tick: ++now,
      speakerPosition: { x: 0, y: 64, z: 0 },
      residents: ['mira', 'tobin', 'pip'].map((residentId) => ({
        residentId,
        position: { x: residentId === speakerId ? 0 : 2, y: 64, z: 0 },
      })),
    }),
    rememberHeardSpeech: (event, speakerName) => { remembered.push({ eventId: event.eventId, speakerName }); },
    residentName: (residentId) => ({ mira: 'Anna', tobin: 'James', pip: 'Thomas' })[residentId],
  });
  return { runtime, emitted, remembered, advance: (ms: number) => { now += ms; } };
}

test('runtime sends routine and fresh player-heard events to the production coordinator', () => {
  const { runtime, emitted, advance } = createHarness();
  runtime.setResidentBusy('mira', true);
  runtime.routineEntered({ eventId: 'routine_mira_001', residentId: 'mira', activity: 'watering seedlings', motivation: 'protect the garden' });
  assert.equal(emitted.filter(({ type }) => type === 'village.native.reaction').length, 0);

  runtime.completePlayerSpeech([{
    eventId: 'player-speech:utterance_1', speakerId: 'player', text: 'The path is clear.',
    recipientIds: ['mira', 'tobin'], completedAtTick: 10_001,
  }]);
  const immediate = emitted.filter(({ type }) => type === 'village.native.reaction');
  assert.deepEqual(immediate.map(({ residentId }) => residentId), ['tobin']);

  advance(1);
  runtime.setResidentBusy('mira', false);
  const dispatched = emitted.filter(({ type }) => type === 'village.native.reaction');
  assert.deepEqual(dispatched.map(({ residentId }) => residentId), ['tobin', 'mira']);
  assert.ok(dispatched.every(({ origin }) => origin === 'player'));
});

test('runtime remembers and schedules only fresh completed resident perceptions', () => {
  const { runtime, emitted, remembered } = createHarness();
  runtime.completeResidentSpeech({
    type: 'resident.speech.perceived', eventId: 'resident-speech:reply_0001', speakerId: 'mira',
    responseId: 'response_1', text: 'The west garden is ready.', recipientIds: ['tobin', 'pip'],
    startedAtTick: 10_000, completedAtTick: 10_300,
  });
  assert.deepEqual(remembered, [{ eventId: 'resident-speech:reply_0001', speakerName: 'Anna' }]);
  assert.deepEqual(emitted.filter(({ type }) => type === 'village.native.reaction').map(({ residentId, origin }) => ({ residentId, origin })), [
    { residentId: 'tobin', origin: 'resident' }, { residentId: 'pip', origin: 'resident' },
  ]);
});

test('reaction acknowledgements are emitted with server correlation and playback sampling stays active', () => {
  const { runtime, emitted } = createHarness();
  runtime.routineEntered({ eventId: 'routine_mira_002', residentId: 'mira', activity: 'walking to market', motivation: 'serve neighbors' });
  const candidate = emitted.find(({ type }) => type === 'village.native.reaction');
  assert.ok(candidate);
  const ack = runtime.handle({ version: 1, type: 'ptt.reaction.ack', eventId: candidate.eventId,
    residentId: candidate.residentId, reactionId: 'reaction_0001', status: 'accepted', at: 10_000 });
  assert.equal(ack.status, 'accepted');
  assert.equal(emitted.at(-1), ack);
  runtime.handle({ version: 1, type: 'ptt.reaction.speech.start', eventId: candidate.eventId,
    residentId: candidate.residentId, reactionId: 'reaction_0001', responseId: 'response_1', itemId: 'item_1', at: 10_001 });
  runtime.sampleActivePlayback();
  assert.equal(runtime.activeCount, 1);
});

test('resident snapshots carry player and residents from one authoritative timestamp', () => {
  const snapshot = createVillageResidentPositionSnapshot(42_000,
    { x: 1, y: 64, z: 2 }, [{ residentId: 'mira', name: 'Anna', position: { x: 3, y: 64, z: 4 } }]);
  assert.deepEqual(snapshot, {
    type: 'village.residents', timestamp: 42_000, playerPosition: { x: 1, y: 64, z: 2 },
    residents: [{ residentId: 'mira', name: 'Anna', position: { x: 3, y: 64, z: 4 } }],
  });
});

test('resident snapshot heartbeat publishes every second and can be stopped', () => {
  let callback: (() => void) | undefined;
  let delay = 0;
  let cancelled = false;
  let published = 0;
  const stop = startResidentPositionSnapshotHeartbeat(() => { published += 1; },
    (next, intervalMs) => { callback = next; delay = intervalMs; return {} as ReturnType<typeof setInterval>; },
    () => { cancelled = true; });
  assert.equal(delay, RESIDENT_POSITION_SNAPSHOT_INTERVAL_MS);
  callback?.();
  assert.equal(published, 1);
  stop();
  assert.equal(cancelled, true);
});
