import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalGateway } from './goal-gateway.ts';
import type { Goal } from '../../contracts/src/index.ts';

test('accepts only safe typed goals and schedules them through the injected executor', async () => {
  const executed: Goal[] = [];
  const gateway = createGoalGateway({
    port: 0,
    execute: async (goal) => { executed.push(goal); return { status: 'completed' }; },
  });
  await new Promise<void>((resolve) => gateway.server.once('listening', resolve));
  const address = gateway.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const accepted = await fetch(`${base}/goals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'follow', args: { target: 'player' } }),
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).status, 'accepted');
    await gateway.scheduler.drain();
    assert.equal(executed[0]?.kind, 'follow');
    assert.equal(executed[0]?.source, 'voice');
    assert.equal(executed[0]?.priority, 'user');

    const crossSite = await fetch(`${base}/goals`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' },
      body: JSON.stringify({ kind: 'follow', args: {} }),
    });
    assert.equal(crossSite.status, 403);
    assert.equal(executed.length, 1);

    const rejected = await fetch(`${base}/goals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'follow', args: { shell: 'dangerous' } }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(executed.length, 1);

    const stopped = await fetch(`${base}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).status, 'completed');
  } finally {
    await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('rejects new goals but allows stop requests when Minecraft is disconnected', async () => {
  const executed: Goal[] = [];
  const gateway = createGoalGateway({
    port: 0,
    execute: async (goal) => {
      executed.push(goal);
      return goal.kind === 'stop'
        ? { status: 'failed', detail: 'Minecraft adapter is not connected' }
        : { status: 'completed' };
    },
    isReady: () => false,
  });
  await new Promise<void>((resolve) => gateway.server.once('listening', resolve));
  const address = gateway.server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/goals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'follow', args: {} }),
    });
    assert.equal(response.status, 503);
    assert.equal(gateway.scheduler.queuedGoals.length, 0);

    const stopped = await fetch(`http://127.0.0.1:${address.port}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(stopped.status, 503);
    assert.equal((await stopped.json()).status, 'failed');
    assert.equal(executed.some((goal) => goal.kind === 'stop'), true);
  } finally {
    await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('refuses to bind the goal gateway outside loopback', () => {
  assert.throws(() => createGoalGateway({
    host: '0.0.0.0',
    execute: async () => ({ status: 'completed' }),
  }), /loopback/);
});


test('exposes readiness, active goals, and timestamped lifecycle events for the demo overlay', async () => {
  let finish!: (result: { status: 'completed'; detail: string }) => void;
  const gateway = createGoalGateway({
    port: 0,
    execute: async () => await new Promise((resolve) => { finish = resolve; }),
  });
  await new Promise<void>((resolve) => gateway.server.once('listening', resolve));
  const address = gateway.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const initial = await fetch(`${base}/status`);
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      ready: true,
      objective: null,
      currentGoal: null,
      queuedGoals: [],
      events: [],
    });

    const accepted = await fetch(`${base}/goals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'follow', args: { target: 'player' } }),
    });
    assert.equal(accepted.status, 202);
    const active = await fetch(`${base}/status`).then((response) => response.json());
    assert.equal(active.currentGoal.kind, 'follow');
    assert.equal(active.events.at(-1).type, 'action.started');
    assert.equal(typeof active.events.at(-1).eventId, 'string');
    assert.equal(typeof active.events.at(-1).timestamp, 'number');

    finish({ status: 'completed', detail: 'Reached player' });
    await gateway.scheduler.drain();
    const completed = await fetch(`${base}/status`).then((response) => response.json());
    assert.equal(completed.currentGoal, null);
    assert.equal(completed.events.at(-1).type, 'action.completed');
    assert.equal(completed.events.at(-1).detail, 'Reached player');
    assert.equal(typeof completed.events.at(-1).latencyMs, 'number');
  } finally {
    await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()));
  }
});
