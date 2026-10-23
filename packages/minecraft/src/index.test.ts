import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { loadMinecraftAdapter, MinecraftAdapter, type MinecraftRuntime } from './index.ts';

class FakeGoalFollow {
  readonly entity: object;
  readonly range: number;
  constructor(entity: object, range: number) { this.entity = entity; this.range = range; }
}

class FakeGoalNear {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly range: number;
  constructor(x: number, y: number, z: number, range: number) { this.x = x; this.y = y; this.z = z; this.range = range; }
}

class FakeBot extends EventEmitter {
  username = 'BosonCompanion';
  entity = { position: { x: 0, y: 64, z: 0 }, health: 20 };
  players: Record<string, { entity?: { position: { x: number; y: number; z: number }; username: string } }> = {
    David: { entity: { username: 'David', position: { x: 4, y: 64, z: 0 } } },
  };
  inventory = { items: () => [{ name: 'oak_log', count: 3 }] };
  controlsCleared = false;
  quitCalled = false;
  movementConfigured = false;
  pathfinder = {
    setMovements: (_movements: unknown) => { this.movementConfigured = true; },
    currentGoal: null as unknown,
    dynamic: false,
    gotoGoal: null as unknown,
    gotoResult: Promise.resolve(),
    setGoal: (goal: unknown, dynamic = false) => {
      this.pathfinder.currentGoal = goal;
      this.pathfinder.dynamic = dynamic;
    },
    goto: (goal: unknown) => {
      this.pathfinder.gotoGoal = goal;
      this.pathfinder.currentGoal = goal;
      return this.pathfinder.gotoResult;
    },
  };

  loadPlugin(_plugin: unknown): void {}
  clearControlStates(): void { this.controlsCleared = true; }
  quit(): void { this.quitCalled = true; this.emit('end'); }
}

function setup(options: { spawn?: boolean; connectTimeoutMs?: number } = {}) {
  const bot = new FakeBot();
  let createOptions: Record<string, unknown> | undefined;
  const runtime: MinecraftRuntime = {
    createBot: (value) => { createOptions = value; return bot; },
    pathfinderPlugin: () => undefined,
    Movements: class { constructor(_bot: MineflayerBot) {} },
    goals: { GoalFollow: FakeGoalFollow, GoalNear: FakeGoalNear },
  };
  const adapter = new MinecraftAdapter(runtime, {
    host: '127.0.0.1', port: 25565, username: 'BosonCompanion', playerName: 'David',
    connectTimeoutMs: options.connectTimeoutMs ?? 100,
  });
  const connecting = adapter.connect();
  if (options.spawn !== false) bot.emit('spawn');
  return { adapter, bot, connecting, getCreateOptions: () => createOptions };
}

test('connects to the configured local server and reports observed player and bot state', async () => {
  const { adapter, bot, connecting, getCreateOptions } = setup();
  await connecting;
  assert.equal(bot.movementConfigured, true);
  assert.deepEqual(getCreateOptions(), {
    host: '127.0.0.1', port: 25565, username: 'BosonCompanion', version: '1.21.11', auth: 'offline',
  });
  const observation = await adapter.observe();
  assert.equal(observation.game, 'minecraft');
  assert.equal(typeof observation.timestamp, 'number');
  assert.deepEqual({ player: observation.player, agent: observation.agent, inventory: observation.inventory }, {
    player: { position: [4, 64, 0] }, agent: { position: [0, 64, 0], health: 20 }, inventory: { oak_log: 3 },
  });
  assert.equal(bot.listenerCount('spawn'), 0);
});

test('follow tracks the configured player and stays active until cancelled', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const controller = new AbortController();
  let settled = false;
  const result = adapter.execute({ id: 'follow-1', kind: 'follow', priority: 'user', source: 'voice', args: {} }, controller.signal)
    .then((outcome) => { settled = true; return outcome; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(bot.pathfinder.currentGoal instanceof FakeGoalFollow);
  assert.equal(bot.pathfinder.dynamic, true);
  bot.players.David.entity!.position = { x: 1, y: 64, z: 0 };
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settled, false);
  controller.abort('Stop requested');
  assert.deepEqual(await result, { status: 'cancelled', detail: 'Stop requested' });
});

test('cancelling follow immediately clears movement and reports cancellation', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const controller = new AbortController();
  const result = adapter.execute({ id: 'follow-2', kind: 'follow', priority: 'user', source: 'voice', args: {} }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort('Stopped by user');
  assert.deepEqual(await result, { status: 'cancelled', detail: 'Stopped by user' });
  assert.equal(bot.pathfinder.currentGoal, null);
  assert.equal(bot.controlsCleared, true);
});

test('stop clears any active navigation without requiring a Minecraft account', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const result = await adapter.execute({ id: 'stop-1', kind: 'stop', priority: 'emergency', source: 'voice', args: {} }, new AbortController().signal);
  assert.deepEqual(result, { status: 'completed', detail: 'Stopped navigation and cleared movement controls.' });
  assert.equal(bot.pathfinder.currentGoal, null);
  assert.equal(bot.controlsCleared, true);
});

test('approach targets the player and retreat returns to the captured spawn point', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const signal = new AbortController().signal;
  assert.equal((await adapter.execute({ id: 'approach-1', kind: 'approach', priority: 'user', source: 'voice', args: {} }, signal)).status, 'completed');
  assert.ok(bot.pathfinder.gotoGoal instanceof FakeGoalNear);
  assert.equal((bot.pathfinder.gotoGoal as FakeGoalNear).x, 4);
  assert.equal((bot.pathfinder.gotoGoal as FakeGoalNear).range, 2);
  bot.entity.position = { x: 20, y: 64, z: 20 };
  await adapter.execute({ id: 'retreat-1', kind: 'retreat', priority: 'emergency', source: 'voice', args: {} }, signal);
  assert.ok(bot.pathfinder.gotoGoal instanceof FakeGoalNear);
  assert.deepEqual(bot.pathfinder.gotoGoal, new FakeGoalNear(0, 64, 0, 1));
});

test('returns a useful failure when the configured player is not present', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  delete bot.players.David;
  assert.deepEqual(await adapter.execute({ id: 'follow-3', kind: 'follow', priority: 'user', source: 'voice', args: {} }, new AbortController().signal), {
    status: 'failed', detail: 'Player David is not visible in the Minecraft world.',
  });
});

test('fails closed for non-loopback hosts and malformed local usernames', () => {
  const { adapter } = setup();
  assert.throws(() => new MinecraftAdapter({
    createBot: () => new FakeBot(), pathfinderPlugin: () => undefined, Movements: class { constructor(_bot: MineflayerBot) {} }, goals: { GoalFollow: FakeGoalFollow, GoalNear: FakeGoalNear },
  }, { host: '0.0.0.0' }), /loopback/);
  assert.throws(() => new MinecraftAdapter({
    createBot: () => new FakeBot(), pathfinderPlugin: () => undefined, Movements: class { constructor(_bot: MineflayerBot) {} }, goals: { GoalFollow: FakeGoalFollow, GoalNear: FakeGoalNear },
  }, { username: 'bad name' }), /username/);
  assert.deepEqual(adapter.capabilities(), ['follow', 'stop', 'approach', 'retreat', 'report']);
});

test('connection timeout is explicit and resets adapter state', async () => {
  const { adapter, bot, connecting } = setup({ spawn: false, connectTimeoutMs: 5 });
  await assert.rejects(connecting, /timed out/);
  assert.equal(adapter.isReady, false);
  assert.equal(bot.quitCalled, true);
});

test('unsupported goals and failed pathfinding return truthful failures', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const signal = new AbortController().signal;
  assert.deepEqual(await adapter.execute({ id: 'gather-1', kind: 'gather', priority: 'user', source: 'voice', args: {} }, signal), {
    status: 'failed', detail: 'Minecraft adapter does not support gather.',
  });
  bot.pathfinder.gotoResult = Promise.reject(new Error('No path to goal'));
  assert.deepEqual(await adapter.execute({ id: 'approach-2', kind: 'approach', priority: 'user', source: 'voice', args: {} }, signal), {
    status: 'failed', detail: 'No path to goal',
  });
});

test('disconnect stops navigation and makes observations unavailable', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  await adapter.disconnect();
  assert.equal(adapter.isReady, false);
  assert.equal(bot.quitCalled, true);
  await assert.rejects(adapter.observe(), /not connected/);
});

test('loads the installed CommonJS Mineflayer and pathfinder packages', async () => {
  const adapter = await loadMinecraftAdapter();
  assert.deepEqual(adapter.capabilities(), ['follow', 'stop', 'approach', 'retreat', 'report']);
});
