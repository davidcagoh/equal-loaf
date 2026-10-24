import assert from 'node:assert/strict';
import test from 'node:test';
import { ResidentNativeReactionPolicy } from './village-native-reaction-policy.ts';

test('heard events displace pending routine prompts and dispatch before routines across residents', () => {
  const policy = new ResidentNativeReactionPolicy({ maxQueuedPerResident: 2 });
  policy.enqueue({ eventId: 'routine_a', residentId: 'mira', kind: 'routine', at: 10, activity: 'weeding', motivation: 'care for seedlings' });
  policy.enqueue({ eventId: 'routine_b', residentId: 'mira', kind: 'routine', at: 11, activity: 'watering', motivation: 'keep plants healthy' });
  assert.equal(policy.enqueue({
    eventId: 'player-speech:heard_1', residentId: 'mira', kind: 'heard', at: 12,
    speakerId: 'player', speakerName: 'the player', text: 'The bridge looks busy.', origin: 'player',
  }).status, 'queued');

  policy.enqueue({ eventId: 'routine_c', residentId: 'tobin', kind: 'routine', at: 12, activity: 'checking the path', motivation: 'keep neighbors safe' });
  const first = policy.takeNext(13);
  assert.equal(first?.residentId, 'mira');
  assert.equal(first?.eventId, 'player-speech:heard_1');
  assert.equal(policy.takeNext(13)?.residentId, 'tobin');
});

test('global active limit spans residents and frees capacity on release', () => {
  const policy = new ResidentNativeReactionPolicy({ maxActive: 3 });
  for (const residentId of ['mira', 'tobin', 'pip', 'ada']) {
    policy.enqueue({ eventId: `event_${residentId}`, residentId, kind: 'routine', at: 100, activity: 'walking', motivation: 'visit neighbors' });
  }

  assert.deepEqual(['mira', 'tobin', 'pip'].map(() => policy.takeNext(101)?.residentId), ['mira', 'pip', 'tobin']);
  assert.equal(policy.takeNext(101), null);
  assert.equal(policy.activeCount, 3);
  assert.equal(policy.release('mira', 'event_mira'), true);
  assert.equal(policy.takeNext(102)?.residentId, 'ada');
});

test('causal depth, self-hearing, dedupe, pending expiry, and active expiry stay bounded', () => {
  const policy = new ResidentNativeReactionPolicy({ eventTtlMs: 1_000 });
  const heard = {
    eventId: 'resident-speech:heard_2', residentId: 'mira', kind: 'heard' as const, at: 100,
    speakerId: 'tobin', speakerName: 'Tobin', text: 'I found a path.', origin: 'native-reaction' as const, causalDepth: 1,
  };
  assert.equal(policy.enqueue(heard).status, 'queued');
  assert.equal(policy.enqueue(heard).status, 'duplicate');
  assert.equal(policy.enqueue({ ...heard, eventId: 'self_heard', speakerId: 'mira' }).status, 'self-heard');
  assert.equal(policy.enqueue({ ...heard, eventId: 'chain_limit', causalDepth: 2 }).status, 'reaction-chain-limit');
  assert.equal(policy.takeNext(101)?.causalDepth, 2);
  assert.equal(policy.activeCount, 1);
  assert.deepEqual(policy.prune(1_101), [{ residentId: 'mira', eventId: 'resident-speech:heard_2' }]);
  assert.equal(policy.activeCount, 0);

  policy.enqueue({ eventId: 'routine_stale', residentId: 'pip', kind: 'routine', at: 2_000, activity: 'baking', motivation: 'share food' });
  assert.equal(policy.takeNext(3_000), null);
});
