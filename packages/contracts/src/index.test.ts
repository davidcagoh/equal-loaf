import assert from 'node:assert/strict';
import test from 'node:test';
import {
  goalKinds,
  parseGoalProposal,
  validateGoalCapability,
  type CompanionEvent,
} from './index.ts';

test('accepts only whitelisted goal kinds from untrusted model output', () => {
  const parsed = parseGoalProposal({
    id: 'goal-1',
    kind: 'follow',
    priority: 'user',
    args: { target: 'player' },
    source: 'voice',
  });

  assert.equal(parsed.kind, 'follow');
  assert.deepEqual(goalKinds, [
    'follow', 'stop', 'approach', 'gather', 'give', 'defend', 'retreat', 'report',
  ]);
});

test('rejects unknown, malformed, or executable goal proposals', () => {
  for (const proposal of [
    { id: '1', kind: 'craft', priority: 'user', args: {}, source: 'voice' },
    { id: '1', kind: 'follow', priority: 'urgent', args: {}, source: 'voice' },
    { id: '1', kind: 'follow', priority: 'user', args: null, source: 'voice' },
    { id: '1', kind: 'follow', priority: 'user', args: {}, source: 'shell' },
    { id: '1', kind: 'follow', priority: 'user', args: {}, source: 'voice', command: 'rm -rf /' },
    { id: '1', kind: 'follow', priority: 'user', args: { nested: { command: 'run' } }, source: 'voice' },
    { id: '1', kind: 'follow', priority: 'user', args: { distance: Number.NaN }, source: 'voice' },
  ]) {
    assert.throws(() => parseGoalProposal(proposal));
  }
});

test('rejects cyclic and excessively nested argument objects', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => parseGoalProposal({
    id: 'goal-cycle', kind: 'report', priority: 'user', args: cyclic, source: 'agent',
  }));

  let nested: unknown = 'leaf';
  for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
  assert.throws(() => parseGoalProposal({
    id: 'goal-deep', kind: 'report', priority: 'user', args: { nested }, source: 'agent',
  }));
});

test('checks adapter capabilities before a goal reaches execution', () => {
  const goal = parseGoalProposal({
    id: 'goal-2', kind: 'gather', priority: 'user', args: { item: 'oak_log' }, source: 'voice',
  });

  assert.equal(validateGoalCapability(goal, ['follow', 'gather']), true);
  assert.throws(() => validateGoalCapability(goal, ['follow']));
});

test('models action lifecycle events with timestamps, goal identity, status, and failure detail', () => {
  const event = {
    type: 'action.failed',
    eventId: 'event-1',
    timestamp: 123,
    goalId: 'goal-2',
    reason: 'No reachable tree',
    latencyMs: 250,
  } satisfies CompanionEvent;

  assert.equal(event.type, 'action.failed');
  assert.equal(event.reason, 'No reachable tree');
  assert.equal(event.latencyMs, 250);
});
