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
      body: JSON.stringify({ kind: 'follow', args: { target: 'player' }, objective: 'Build a small oak house' }),
    });
    assert.equal(accepted.status, 202);
    const acceptedBody = await accepted.json();
    assert.match(acceptedBody.goalId, /^voice-/);
    assert.equal(acceptedBody.status, 'accepted');
    assert.equal(acceptedBody.objective, 'Build a small oak house');
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

    const invalidObjective = await fetch(`${base}/goals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'follow', args: {}, objective: '   ' }),
    });
    assert.equal(invalidObjective.status, 400);
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
    observe: async () => ({ timestamp: 123, game: 'minecraft', agent: { position: [1, 2, 3] } }),
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
      observation: { timestamp: 123, game: 'minecraft', agent: { position: [1, 2, 3] } },
    });

    const accepted = await fetch(`${base}/goals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'follow', args: { target: 'player' }, objective: 'Build a small oak house' }),
    });
    assert.equal(accepted.status, 202);
    const acceptedBody = await accepted.json();
    const goalId = acceptedBody.goalId as string;
    const pending = await fetch(`${base}/results/${goalId}?kind=follow`);
    assert.equal(pending.status, 202);
    assert.match((await pending.json()).message, /has not completed yet/);
    const wrongKind = await fetch(`${base}/results/${goalId}?kind=gather`);
    assert.equal(wrongKind.status, 400);
    const duplicateKind = await fetch(`${base}/results/${goalId}?kind=follow&kind=gather`);
    assert.equal(duplicateKind.status, 400);

    const queued = await fetch(`${base}/goals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'follow', args: { target: 'player' } }),
    });
    const queuedId = (await queued.json()).goalId as string;
    const queuedResult = await fetch(`${base}/results/${queuedId}?kind=follow`);
    assert.equal(queuedResult.status, 202);
    assert.equal((await queuedResult.json()).status, 'queued');
    assert.equal(await gateway.scheduler.cancel(queuedId, 'test cleanup'), true);

    const active = await fetch(`${base}/status`).then((response) => response.json());
    assert.equal(active.currentGoal.kind, 'follow');
    assert.equal(active.objective, 'Build a small oak house');
    const started = active.events.find((event: { goalId: string; type: string }) => event.goalId === goalId && event.type === 'action.started');
    assert.ok(started);
    assert.equal(typeof started.eventId, 'string');
    assert.equal(typeof started.timestamp, 'number');

    finish({ status: 'completed', detail: 'Reached player' });
    await gateway.scheduler.drain();
    const completed = await fetch(`${base}/status`).then((response) => response.json());
    assert.equal(completed.currentGoal, null);
    const terminal = completed.events.find((event: { goalId: string; type: string }) => event.goalId === goalId && event.type === 'action.completed');
    assert.ok(terminal, JSON.stringify(completed.events));
    assert.equal(terminal.detail, 'Reached player');
    assert.equal(typeof terminal.latencyMs, 'number');
    const outcome = await fetch(`${base}/results/${goalId}?kind=follow`);
    assert.equal(outcome.status, 200);
    const outcomeBody = await outcome.json();
    assert.equal(outcomeBody.status, 'completed');
    assert.equal(outcomeBody.objective, 'Build a small oak house');
    assert.match(outcomeBody.message, /Reached player/);
    const missing = await fetch(`${base}/results/not-known?kind=follow`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()));
  }
});
