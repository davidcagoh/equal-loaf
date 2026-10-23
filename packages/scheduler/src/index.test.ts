import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalScheduler } from './index.ts';
import type { Goal, GoalResult } from '../../contracts/src/index.ts';

function goal(id: string, kind: Goal['kind'] = 'follow', priority: Goal['priority'] = 'user'): Goal {
  return { id, kind, priority, source: 'voice', args: { target: 'player' } };
}

test('runs compatible goals in sequence and preserves the strategic objective', async () => {
  const order: string[] = [];
  const scheduler = new GoalScheduler(async (current) => {
    order.push(current.id);
    return { status: 'completed' };
  });
  scheduler.setObjective('explore the forest');
  await scheduler.submit(goal('one'));
  await scheduler.submit(goal('two'));
  await scheduler.drain();
  assert.deepEqual(order, ['one', 'two']);
  assert.equal(scheduler.objective, 'explore the forest');
});

test('preempts ahead of queued background work and suppresses its stale completion', async () => {
  let finishFirst!: (result: GoalResult) => void;
  const events: string[] = [];
  const scheduler = new GoalScheduler((current) => current.id === 'first'
    ? new Promise<GoalResult>((resolve) => { finishFirst = resolve; })
    : Promise.resolve({ status: 'completed' }), (event) => events.push(event.type));
  await scheduler.submit(goal('first', 'gather', 'proactive'));
  await scheduler.submit(goal('background', 'report', 'background'));
  await scheduler.submit(goal('urgent', 'retreat', 'user'));
  finishFirst({ status: 'completed' });
  await scheduler.drain();
  assert.deepEqual(events.filter((event) => event === 'action.completed'), ['action.completed', 'action.completed']);
  assert.equal(events.includes('action.cancelled'), false);
});

test('stop overrides work, clears queued goals, and acknowledges only confirmed cancellation', async () => {
  let finish!: (result: GoalResult) => void;
  const events: string[] = [];
  const scheduler = new GoalScheduler((current, signal) => current.id === 'long'
    ? new Promise<GoalResult>((resolve) => {
      signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
      finish = resolve;
    })
    : Promise.resolve(current.kind === 'stop' ? { status: 'cancelled' } : { status: 'completed' }),
  (event) => events.push(`${event.type}:${event.goalId ?? ''}`));
  await scheduler.submit(goal('long'));
  await scheduler.submit(goal('queued', 'gather', 'background'));
  assert.equal(scheduler.queuedGoals.length, 1);
  await scheduler.stop();
  finish({ status: 'completed' });
  await scheduler.drain();
  assert.equal(events.includes('action.cancelled:long'), true);
  assert.equal(events.includes('action.completed:long'), false);
  assert.equal(events.some((event) => event.startsWith('action.cancelled:stop-')), true);
  assert.equal(scheduler.queuedGoals.length, 0);
});

test('reports timeout and proceeds without accepting a late result', async () => {
  let finish!: (result: GoalResult) => void;
  const events: string[] = [];
  const scheduler = new GoalScheduler((current) => current.id === 'slow'
    ? new Promise<GoalResult>((resolve) => { finish = resolve; })
    : Promise.resolve({ status: 'completed' }), (event) => events.push(event.type), { timeoutMs: 10 });
  await scheduler.submit(goal('slow'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  finish({ status: 'completed' });
  await scheduler.submit(goal('next'));
  await scheduler.drain();
  assert.equal(events.includes('action.failed'), true);
  assert.equal(events.filter((event) => event === 'action.completed').length, 1);
});

test('runs the stop action immediately even if an action ignores cancellation', async () => {
  let finish!: (result: GoalResult) => void;
  const order: string[] = [];
  const scheduler = new GoalScheduler((current) => {
    order.push(current.id);
    return current.id === 'stubborn'
      ? new Promise<GoalResult>((resolve) => { finish = resolve; })
      : Promise.resolve({ status: 'completed' });
  }, () => undefined, { timeoutMs: 100 });
  await scheduler.submit(goal('stubborn'));
  await scheduler.stop('halt-now');
  assert.deepEqual(order, ['stubborn', 'halt-now']);
  finish({ status: 'completed' });
  await scheduler.drain();
});

test('queues submissions made during stop until stop completes', async () => {
  let finishActive!: (result: GoalResult) => void;
  let finishStop!: (result: GoalResult) => void;
  const calls: string[] = [];
  const scheduler = new GoalScheduler((current) => {
    calls.push(current.id);
    if (current.id === 'active') return new Promise<GoalResult>((resolve) => { finishActive = resolve; });
    if (current.kind === 'stop') return new Promise<GoalResult>((resolve) => { finishStop = resolve; });
    return Promise.resolve({ status: 'completed' });
  });
  await scheduler.submit(goal('active'));
  const stopping = scheduler.stop('halt');
  await scheduler.submit(goal('after-stop'));
  finishActive({ status: 'completed' });
  await Promise.resolve();
  assert.deepEqual(calls, ['active', 'halt']);
  let drained = false;
  const draining = scheduler.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finishStop({ status: 'completed' });
  await stopping;
  await draining;
  assert.deepEqual(calls, ['active', 'halt', 'after-stop']);
});
