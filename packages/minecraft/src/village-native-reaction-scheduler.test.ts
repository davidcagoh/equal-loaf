import assert from 'node:assert/strict';
import test from 'node:test';
import { ResidentNativeReactionScheduler } from './village-native-reaction-scheduler.ts';

test('queues independent, attributed reactions for routine and heard events', () => {
  const scheduler = new ResidentNativeReactionScheduler();
  const routine = scheduler.enqueue({
    eventId: 'routine-mira-1', residentId: 'mira', kind: 'routine', at: 1_000,
    activity: 'watering the west garden', motivation: 'keep the seedlings healthy',
  });
  const heard = scheduler.enqueue({
    eventId: 'player-utterance-1', residentId: 'tobin', kind: 'heard', at: 1_000,
    speakerId: 'player', speakerName: 'the newcomer', text: 'The path is muddy after the rain.',
  });
  scheduler.enqueue({
    eventId: 'routine-pip-1', residentId: 'pip', kind: 'routine', at: 1_000,
    activity: 'setting aside a loaf', motivation: 'welcome each household',
  });

  assert.equal(routine.status, 'queued');
  assert.equal(heard.status, 'queued');
  assert.match(scheduler.takeNext('mira', 1_001)?.context ?? '', /watering the west garden/);
  const tobin = scheduler.takeNext('tobin', 1_001);
  assert.match(tobin?.context ?? '', /heard the newcomer say/);
  assert.match(tobin?.context ?? '', /unverified claim/);
  assert.equal(scheduler.takeNext('mira', 1_001), null, 'a resident cannot overlap its own reactions');
  assert.notEqual(scheduler.takeNext('pip', 1_001), null, 'another resident is not blocked by Mira or Tobin');
});

test('deduplicates events, rejects self-heard and reaction-origin speech, and enforces a bounded per-resident queue', () => {
  const scheduler = new ResidentNativeReactionScheduler({ maxQueuedPerResident: 2 });
  const heard = {
    eventId: 'resident-utterance-1', residentId: 'mira', kind: 'heard' as const, at: 10_000,
    speakerId: 'tobin', speakerName: 'Tobin', text: 'I counted each house.',
  };
  assert.equal(scheduler.enqueue(heard).status, 'queued');
  assert.equal(scheduler.enqueue(heard).status, 'duplicate');
  assert.equal(scheduler.enqueue({ ...heard, eventId: 'self-heard', speakerId: 'mira' }).status, 'self-heard');
  assert.equal(scheduler.enqueue({ ...heard, eventId: 'reaction-one-hop', origin: 'native-reaction', causalDepth: 1 }).status, 'queued');
  assert.equal(scheduler.enqueue({ ...heard, eventId: 'reaction-chain-limit', origin: 'native-reaction', causalDepth: 2 }).status, 'reaction-chain-limit');
  assert.equal(scheduler.enqueue({ ...heard, eventId: 'second' }).status, 'queue-full');
});

test('does not reuse expired pending events and bounds text sent to a native session', () => {
  const scheduler = new ResidentNativeReactionScheduler({ eventTtlMs: 5_000 });
  assert.equal(scheduler.enqueue({
    eventId: 'old-routine', residentId: 'pip', kind: 'routine', at: 1_000,
    activity: 'baking bread '.repeat(200), motivation: 'feed households',
  }).status, 'queued');
  assert.equal(scheduler.takeNext('pip', 6_001), null);

  const expiringQueue = new ResidentNativeReactionScheduler({ maxQueuedPerResident: 1, eventTtlMs: 1_000 });
  assert.equal(expiringQueue.enqueue({ eventId: 'stale', residentId: 'mira', kind: 'routine', at: 1_000, activity: 'weeding', motivation: 'tend the garden' }).status, 'queued');
  assert.equal(expiringQueue.enqueue({ eventId: 'fresh-after-expiry', residentId: 'mira', kind: 'routine', at: 2_001, activity: 'watering', motivation: 'keep seedlings healthy' }).status, 'queued');

  const current = scheduler.enqueue({
    eventId: 'fresh-routine', residentId: 'pip', kind: 'routine', at: 7_000,
    activity: 'baking bread '.repeat(200), motivation: 'feed households',
  });
  assert.equal(current.status, 'queued');
  assert.ok(Buffer.byteLength(scheduler.takeNext('pip', 7_001)!.context, 'utf8') <= 1_000);
});

test('a completed resident reaction applies cooldown only to that resident', () => {
  const scheduler = new ResidentNativeReactionScheduler({ cooldownMs: 10_000 });
  scheduler.enqueue({ eventId: 'mira-1', residentId: 'mira', kind: 'routine', at: 20_000, activity: 'weeding', motivation: 'tend the garden' });
  scheduler.enqueue({ eventId: 'tobin-1', residentId: 'tobin', kind: 'routine', at: 20_000, activity: 'checking the map', motivation: 'keep the household count fair' });
  const mira = scheduler.takeNext('mira', 20_001)!;
  assert.ok(scheduler.takeNext('tobin', 20_001));
  scheduler.complete('mira', mira.eventId, 20_002);
  scheduler.enqueue({ eventId: 'mira-2', residentId: 'mira', kind: 'routine', at: 20_003, activity: 'walking to the well', motivation: 'keep the village supplied' });
  assert.equal(scheduler.takeNext('mira', 20_004), null);
  assert.ok(scheduler.takeNext('mira', 30_003));
});
