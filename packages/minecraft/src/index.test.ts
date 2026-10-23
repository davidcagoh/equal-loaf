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
  entities: Record<string, { name?: string; kind?: string; position: { x: number; y: number; z: number }; isValid?: boolean }> = {};
  inventoryItems = [{ name: 'oak_log', type: 17, count: 3 }];
  inventory = { items: () => this.inventoryItems };
  registry = { itemsByName: { oak_log: { id: 17 } } };
  blocks: Array<{ name: string; position: { x: number; y: number; z: number }; boundingBox: 'block' | 'empty' }> = [
    { name: 'oak_log', position: { x: 2, y: 64, z: 0 }, boundingBox: 'block' },
    { name: 'grass_block', position: { x: 0, y: 63, z: 0 }, boundingBox: 'block' },
  ];
  dugBlocks: unknown[] = [];
  itemDrops: Array<{ position: { x: number; y: number; z: number }; type: string; name: string; metadata: Array<{ itemId: number }> }> = [];
  tossed: Array<{ type: number; metadata: null; count: number }> = [];
  digGate?: Promise<void>;
  digStopped = false;
  findBlocks(options: { matching: (block: { name: string }) => boolean }) {
    return this.blocks.filter(options.matching).map((block) => block.position);
  }
  blockAt(point: { x: number; y: number; z: number }) {
    return this.blocks.find((block) => block.position.x === point.x && block.position.y === point.y && block.position.z === point.z)
      ?? { name: 'air', position: point, boundingBox: 'empty' as const };
  }
  canDigBlock(block: unknown) { return this.blocks.includes(block as typeof this.blocks[number]); }
  gotoGoals: unknown[] = [];
  gotoHook?: (goal: unknown) => void;
  async dig(block: unknown) {
    this.dugBlocks.push(block);
    if (this.digGate) await this.digGate;
    this.blocks = this.blocks.filter(candidate => candidate !== block);
    const dugBlock = block as typeof this.blocks[number];
    const unrelatedDrop = { position: { ...dugBlock.position, x: dugBlock.position.x + 2 }, type: 'object', name: 'item', metadata: [{ itemId: 1 }] };
    const logDrop = { position: { ...dugBlock.position }, type: 'object', name: 'item', metadata: [{ itemId: 17 }] };
    this.itemDrops.push(logDrop, unrelatedDrop);
    this.emit('itemDrop', logDrop);
    this.emit('itemDrop', unrelatedDrop);
  }
  stopDigging(): void { this.digStopped = true; }
  async toss(type: number, metadata: null, count: number) { this.tossed.push({ type, metadata, count }); }
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
      this.gotoGoals.push(goal);
      this.pathfinder.gotoGoal = goal;
      this.pathfinder.currentGoal = goal;
      if (goal instanceof FakeGoalNear) this.entity.position = { x: goal.x, y: goal.y, z: goal.z };
      this.gotoHook?.(goal);
      if (goal instanceof FakeGoalNear && goal.range === 0.5) {
        const dropIndex = this.itemDrops.findIndex(drop => drop.position.x === goal.x && drop.position.y === goal.y && drop.position.z === goal.z);
        if (dropIndex !== -1) {
          const [drop] = this.itemDrops.splice(dropIndex, 1);
          if (drop!.metadata.some(value => value.itemId === 17)) this.inventoryItems[0]!.count += 1;
        }
      }
      return this.pathfinder.gotoResult;
    },
  };

  loadPlugin(_plugin: unknown): void {}
  clearControlStates(): void { this.controlsCleared = true; }
  quit(): void { this.quitCalled = true; this.emit('end'); }
}

function setup(options: { spawn?: boolean; connectTimeoutMs?: number; spawnPosition?: { x: number; y: number; z: number } } = {}) {
  const bot = new FakeBot();
  if (options.spawnPosition) bot.entity.position = options.spawnPosition;
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

test('resolves the spoken player alias to the configured player', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const controller = new AbortController();
  const result = adapter.execute({ id: 'follow-player-alias', kind: 'follow', priority: 'user', source: 'voice', args: { target: 'player' } }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(bot.pathfinder.currentGoal instanceof FakeGoalFollow);
  controller.abort('Stop requested');
  assert.equal((await result).status, 'cancelled');
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

test('reports observed inventory, health, player presence, and nearby hostiles', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  bot.entities = {
    zombie: { name: 'zombie', kind: 'Hostile mobs', position: { x: 3, y: 64, z: 0 }, isValid: true },
    distantZombie: { name: 'zombie', kind: 'Hostile mobs', position: { x: 40, y: 64, z: 0 }, isValid: true },
  };
  const result = await adapter.execute({ id: 'report-1', kind: 'report', priority: 'user', source: 'voice', args: {} }, new AbortController().signal);
  assert.deepEqual(result, {
    status: 'completed',
    detail: 'Player David is nearby. Bot health is 20. Inventory: 3 oak_log. Nearby hostile mobs: zombie (3 blocks).',
  });
});

test('reports combined counts for duplicate inventory stacks', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  bot.inventoryItems = [
    { name: 'oak_log', type: 17, count: 3 },
    { name: 'oak_log', type: 17, count: 5 },
  ];
  const observation = await adapter.observe();
  assert.deepEqual(observation.inventory, { oak_log: 8 });
});

test('retreat uses the bot current elevation when its captured spawn height is stale', async () => {
  const { adapter, bot, connecting } = setup({ spawnPosition: { x: 0, y: -57, z: 0 } });
  await connecting;
  bot.blocks = [
    { name: 'oak_log', position: { x: 2, y: 64, z: 0 }, boundingBox: 'block' },
    { name: 'grass_block', position: { x: 0, y: -61, z: 0 }, boundingBox: 'block' },
  ];
  bot.entity.position = { x: -20, y: 20, z: 14 };
  await adapter.execute({ id: 'retreat-stale-height', kind: 'retreat', priority: 'emergency', source: 'voice', args: {} }, new AbortController().signal);
  assert.deepEqual(bot.pathfinder.gotoGoal, new FakeGoalNear(0, -60, 0, 1));
});

test('retreat rejects spawn positions with lava or fire in the standing space', async () => {
  const { adapter, bot, connecting } = setup({ spawnPosition: { x: 0, y: -57, z: 0 } });
  await connecting;
  bot.blocks = [
    { name: 'grass_block', position: { x: 0, y: -61, z: 0 }, boundingBox: 'block' },
    { name: 'lava', position: { x: 0, y: -60, z: 0 }, boundingBox: 'empty' },
    { name: 'fire', position: { x: 0, y: -59, z: 0 }, boundingBox: 'empty' },
  ];
  const result = await adapter.execute({ id: 'retreat-hazard', kind: 'retreat', priority: 'emergency', source: 'voice', args: {} }, new AbortController().signal);
  assert.deepEqual(result, { status: 'failed', detail: 'Safe spawn position is not available.' });
  assert.equal(bot.gotoGoals.length, 0);
});

test('gathers reachable log blocks and confirms picked-up inventory', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const result = await adapter.execute({ id: 'gather-1', kind: 'gather', priority: 'user', source: 'voice', args: { item: 'wood', quantity: 1 } }, new AbortController().signal);
  assert.deepEqual(result, { status: 'completed', detail: 'Collected 1 oak log.' });
  assert.equal(bot.dugBlocks.length, 1);
  assert.equal(bot.inventoryItems[0]!.count, 4);
  assert.ok(bot.pathfinder.gotoGoal instanceof FakeGoalNear);
  assert.equal(bot.pathfinder.gotoGoal.range, 0.5);
  assert.deepEqual(bot.pathfinder.gotoGoal && [bot.pathfinder.gotoGoal.x, bot.pathfinder.gotoGoal.y, bot.pathfinder.gotoGoal.z], [2, 64, 0]);
  assert.equal(bot.itemDrops.length, 1);
});

test('cancels active gathering and stops the current dig', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  let releaseDig!: () => void;
  bot.digGate = new Promise<void>((resolve) => { releaseDig = resolve; });
  const controller = new AbortController();
  const result = adapter.execute({ id: 'gather-cancel', kind: 'gather', priority: 'user', source: 'voice', args: { item: 'wood', quantity: 1 } }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(bot.dugBlocks.length, 1);
  controller.abort('Interrupted by player');
  assert.deepEqual(await result, { status: 'cancelled', detail: 'Interrupted by player' });
  assert.equal(bot.digStopped, true);
  releaseDig();
});

test('drops only the requested available item quantity beside the configured player', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const result = await adapter.execute({ id: 'give-1', kind: 'give', priority: 'user', source: 'voice', args: { item: 'oak_log', quantity: 2 } }, new AbortController().signal);
  assert.equal(result.status, 'completed');
  assert.equal(bot.pathfinder.gotoGoal instanceof FakeGoalNear, true);
  assert.deepEqual(bot.tossed, [{ type: 17, metadata: null, count: 2 }]);
});

test('give rechecks a moving player position before dropping items', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  bot.gotoHook = () => {
    if (bot.gotoGoals.length === 1) bot.players.David.entity!.position = { x: 10, y: 64, z: 0 };
  };
  const result = await adapter.execute({ id: 'give-moving-player', kind: 'give', priority: 'user', source: 'voice', args: { item: 'oak_log', quantity: 1 } }, new AbortController().signal);
  assert.equal(result.status, 'completed');
  assert.deepEqual(bot.gotoGoals, [new FakeGoalNear(4, 64, 0, 2), new FakeGoalNear(10, 64, 0, 2)]);
  assert.deepEqual(bot.tossed, [{ type: 17, metadata: null, count: 1 }]);
});

test('uses retreat as the safe fallback for defend when combat is unavailable', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const result = await adapter.execute({ id: 'defend-1', kind: 'defend', priority: 'emergency', source: 'voice', args: {} }, new AbortController().signal);
  assert.deepEqual(result, { status: 'completed', detail: 'Combat is unavailable; returned to the prepared spawn point.' });
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
  assert.deepEqual(adapter.capabilities(), ['follow', 'stop', 'approach', 'gather', 'give', 'defend', 'retreat', 'report']);
});

test('connection timeout is explicit and resets adapter state', async () => {
  const { adapter, bot, connecting } = setup({ spawn: false, connectTimeoutMs: 5 });
  await assert.rejects(connecting, /timed out/);
  assert.equal(adapter.isReady, false);
  assert.equal(bot.quitCalled, true);
});

test('invalid gather requests and failed pathfinding return truthful failures', async () => {
  const { adapter, bot, connecting } = setup();
  await connecting;
  const signal = new AbortController().signal;
  assert.deepEqual(await adapter.execute({ id: 'gather-1', kind: 'gather', priority: 'user', source: 'voice', args: { item: 'diamond' } }, signal), {
    status: 'failed', detail: 'Gather supports logs from reachable trees only.',
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
  assert.deepEqual(adapter.capabilities(), ['follow', 'stop', 'approach', 'gather', 'give', 'defend', 'retreat', 'report']);
});
