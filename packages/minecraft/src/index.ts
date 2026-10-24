import { EventEmitter } from 'node:events';
import type { GameAdapter, Goal, GoalKind, GoalResult, Observation } from '../../contracts/src/index.ts';
import { startPrismarineViewer } from './viewer.ts';

interface Vec3 { x: number; y: number; z: number; offset?(x: number, y: number, z: number): Vec3 }
interface EntityLike { position: Vec3; health?: number; username?: string; type?: string; name?: string; kind?: string; isValid?: boolean; metadata?: unknown[] }
interface PlayerLike { entity?: EntityLike }
interface BlockLike { name: string; position: Vec3; boundingBox: 'block' | 'empty' | 'complex' }
interface InventoryItemLike { name: string; count: number; type?: number }
interface PathfinderLike {
  setMovements(movements: unknown): void;
  setGoal(goal: unknown | null, dynamic?: boolean): void;
  goto(goal: unknown): Promise<void>;
}

export interface MineflayerBot extends EventEmitter {
  username: string;
  entity?: EntityLike;
  players: Record<string, PlayerLike>;
  entities: Record<string, EntityLike>;
  inventory: { items(): InventoryItemLike[] };
  registry: { itemsByName: Record<string, { id: number } | undefined> };
  findBlocks(options: { matching: (block: BlockLike) => boolean; maxDistance: number; count: number }): Vec3[];
  blockAt(point: Vec3): BlockLike | null;
  canDigBlock(block: BlockLike): boolean;
  dig(block: BlockLike, forceLook?: boolean): Promise<void>;
  stopDigging(): void;
  toss(itemType: number, metadata: number | null, count: number | null): Promise<void>;
  pathfinder: PathfinderLike;
  loadPlugin(plugin: unknown): void;
  clearControlStates(): void;
  quit(reason?: string): void;
}

export interface MinecraftRuntime {
  createBot(options: Record<string, unknown>): MineflayerBot;
  pathfinderPlugin: unknown;
  Movements: new (bot: MineflayerBot) => unknown;
  goals: {
    GoalFollow: new (entity: object, range: number) => unknown;
    GoalNear: new (x: number, y: number, z: number, range: number) => unknown;
  };
}

export interface MinecraftAdapterOptions {
  host?: string;
  port?: number;
  username?: string;
  playerName?: string;
  version?: string;
  followRange?: number;
  connectTimeoutMs?: number;
}

const supportedKinds: readonly GoalKind[] = ['follow', 'stop', 'approach', 'gather', 'give', 'defend', 'retreat', 'report'];
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function position(entity: EntityLike | undefined): Vec3 | undefined {
  if (!entity || ![entity.position?.x, entity.position?.y, entity.position?.z].every(Number.isFinite)) return undefined;
  return { x: entity.position.x, y: entity.position.y, z: entity.position.z };
}

function asPosition(value: unknown): Vec3 | undefined {
  if (Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === 'number' && Number.isFinite(part))) {
    return { x: value[0], y: value[1], z: value[2] };
  }
  if (typeof value === 'object' && value !== null && 'x' in value && 'y' in value && 'z' in value) {
    const candidate = value as Record<string, unknown>;
    if ([candidate.x, candidate.y, candidate.z].every((part) => typeof part === 'number' && Number.isFinite(part))) {
      return { x: candidate.x as number, y: candidate.y as number, z: candidate.z as number };
    }
  }
  return undefined;
}

/** Mineflayer-backed deterministic adapter for the local, loopback test world. */
export class MinecraftAdapter implements GameAdapter {
  private bot?: MineflayerBot;
  private ready = false;
  private safeSpawn?: Vec3;
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly playerName: string;
  private readonly version: string;
  private readonly followRange: number;
  private readonly connectTimeoutMs: number;
  private readonly runtime: MinecraftRuntime;

  constructor(runtime: MinecraftRuntime, options: MinecraftAdapterOptions = {}) {
    this.runtime = runtime;
    if (typeof runtime.createBot !== 'function' || typeof runtime.pathfinderPlugin !== 'function'
      || typeof runtime.Movements !== 'function'
      || typeof runtime.goals?.GoalFollow !== 'function' || typeof runtime.goals?.GoalNear !== 'function') {
      throw new TypeError('Mineflayer and pathfinder runtime exports are incomplete');
    }
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 25565;
    this.username = options.username ?? 'BosonCompanion';
    this.playerName = options.playerName ?? 'Player';
    this.version = options.version ?? '1.21.11';
    this.followRange = options.followRange ?? 2;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    if (!loopbackHosts.has(this.host)) throw new TypeError('Minecraft adapter only connects to a loopback server');
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65_535) throw new TypeError('Minecraft port is invalid');
    for (const [label, value] of [['bot username', this.username], ['player name', this.playerName]]) {
      if (!/^[A-Za-z0-9_]{3,16}$/.test(value)) throw new TypeError(`Minecraft ${label} is invalid`);
    }
    if (!Number.isFinite(this.followRange) || this.followRange < 1) throw new TypeError('Follow range must be at least one block');
    if (!Number.isFinite(this.connectTimeoutMs) || this.connectTimeoutMs < 1) throw new TypeError('Connection timeout must be positive');
  }

  get isReady(): boolean { return this.ready && Boolean(this.bot?.entity); }

  startViewer(port = 3000): Promise<() => Promise<void>> {
    return startPrismarineViewer(this.requireBot(), port);
  }

  capabilities(): readonly GoalKind[] { return supportedKinds; }

  async connect(): Promise<void> {
    if (this.isReady) return;
    if (this.bot) throw new Error('Minecraft connection is already in progress');
    const bot = this.runtime.createBot({
      host: this.host,
      port: this.port,
      username: this.username,
      version: this.version,
      auth: 'offline',
    });
    this.bot = bot;
    bot.loadPlugin(this.runtime.pathfinderPlugin);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bot.removeListener('spawn', onSpawn);
        bot.removeListener('error', onError);
        bot.removeListener('end', onEnd);
        if (error) reject(error);
        else resolve();
      };
      const onSpawn = () => {
        bot.pathfinder.setMovements(new this.runtime.Movements(bot));
        this.ready = true;
        this.safeSpawn = position(bot.entity);
        finish();
      };
      const onError = (error: Error) => finish(new Error(`Minecraft connection failed: ${error.message}`));
      const onEnd = () => finish(new Error('Minecraft connection ended before spawn.'));
      const timer = setTimeout(() => finish(new Error(`Minecraft connection timed out after ${this.connectTimeoutMs}ms.`)), this.connectTimeoutMs);
      bot.once('spawn', onSpawn);
      bot.once('error', onError);
      bot.once('end', onEnd);
      bot.on('end', () => {
        this.ready = false;
        this.safeSpawn = undefined;
        if (this.bot === bot) this.bot = undefined;
      });
    }).catch((error: unknown) => {
      bot.quit('Connection failed');
      this.bot = undefined;
      this.ready = false;
      throw error;
    });
  }

  async observe(): Promise<Observation> {
    const bot = this.requireBot();
    const agentPosition = position(bot.entity);
    if (!agentPosition) throw new Error('Minecraft bot position is not available.');
    const playerEntity = bot.players[this.playerName]?.entity;
    const playerPosition = position(playerEntity);
    const inventory = bot.inventory.items().reduce<Record<string, number>>((counts, item) => {
      counts[item.name] = (counts[item.name] ?? 0) + item.count;
      return counts;
    }, {});
    const threats = Object.values(bot.entities)
      .filter((entity) => entity.kind === 'Hostile mobs' && entity.isValid !== false)
      .flatMap((entity) => {
        const threatPosition = position(entity);
        if (!threatPosition) return [];
        const distance = Math.hypot(threatPosition.x - agentPosition.x, threatPosition.y - agentPosition.y, threatPosition.z - agentPosition.z);
        return distance <= 16 ? [`${entity.name ?? 'hostile mob'} (${Math.round(distance)} blocks)`] : [];
      })
      .slice(0, 5);
    return {
      timestamp: Date.now(),
      game: 'minecraft',
      ...(playerPosition ? { player: { position: [playerPosition.x, playerPosition.y, playerPosition.z] as [number, number, number] } } : {}),
      agent: {
        position: [agentPosition.x, agentPosition.y, agentPosition.z],
        ...(typeof bot.entity?.health === 'number' ? { health: bot.entity.health } : {}),
      },
      inventory,
      threats,
    };
  }

  async execute(goal: Goal, signal: AbortSignal): Promise<GoalResult> {
    if (!supportedKinds.includes(goal.kind)) return { status: 'failed', detail: `Minecraft adapter does not support ${goal.kind}.` };
    if (signal.aborted) return { status: 'cancelled', detail: String(signal.reason ?? 'Cancelled before start') };
    const bot = this.requireBot();
    if (goal.kind === 'stop') {
      this.stopNavigation(bot);
      return { status: 'completed', detail: 'Stopped navigation and cleared movement controls.' };
    }
    if (goal.kind === 'report') {
      const observation = await this.observe();
      const playerState = observation.player ? `Player ${this.playerName} is nearby.` : `I cannot see ${this.playerName}.`;
      const health = observation.agent?.health === undefined ? '' : ` Bot health is ${observation.agent.health}.`;
      const inventory = Object.entries(observation.inventory ?? {}).sort(([left], [right]) => left.localeCompare(right))
        .map(([name, count]) => `${count} ${name}`).join(', ') || 'empty';
      const threats = (observation.threats ?? []).filter((threat): threat is string => typeof threat === 'string');
      const threatSummary = threats.length ? ` Nearby hostile mobs: ${threats.join(', ')}.` : ' No nearby hostile mobs detected.';
      return { status: 'completed', detail: `${playerState}${health} Inventory: ${inventory}.${threatSummary}` };
    }
    if (goal.kind === 'gather') return this.gather(bot, goal.args, signal);
    if (goal.kind === 'give') return this.give(bot, goal.args, signal);
    if (goal.kind === 'defend') {
      const spawn = this.retreatTarget(bot);
      if (!spawn) return { status: 'failed', detail: 'Safe spawn position is not available.' };
      return this.goto(bot, spawn, 1, 'Combat is unavailable; returned to the prepared spawn point.', signal);
    }
    if (goal.kind === 'follow' || goal.kind === 'approach') {
      const requestedTarget = typeof goal.args.target === 'string' ? goal.args.target.trim() : '';
      const targetAlias = requestedTarget.toLowerCase();
      const targetName = !requestedTarget || ['me', 'myself', 'you', 'player', 'the player'].includes(targetAlias)
        ? this.playerName
        : requestedTarget;
      if (targetName !== this.playerName) return { status: 'failed', detail: `Only configured player ${this.playerName} can be followed.` };
      const target = bot.players[targetName]?.entity;
      if (!target) return { status: 'failed', detail: `Player ${targetName} is not visible in the Minecraft world.` };
      return goal.kind === 'follow'
        ? this.follow(bot, target, targetName, signal)
        : this.goto(bot, target.position, this.followRange, `Approached ${targetName}.`, signal);
    }
    const spawn = this.retreatTarget(bot);
    if (!spawn) return { status: 'failed', detail: 'Safe spawn position is not available.' };
    return this.goto(bot, spawn, 1, 'Returned to the prepared spawn point.', signal);
  }

  async disconnect(): Promise<void> {
    const bot = this.bot;
    this.bot = undefined;
    this.ready = false;
    this.safeSpawn = undefined;
    if (!bot) return;
    this.stopNavigation(bot);
    bot.quit('Boson companion disconnected');
  }

  private requireBot(): MineflayerBot {
    if (!this.isReady || !this.bot) throw new Error('Minecraft adapter is not connected.');
    return this.bot;
  }

  private stopNavigation(bot: MineflayerBot): void {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }

  private async gather(bot: MineflayerBot, args: Record<string, unknown>, signal: AbortSignal): Promise<GoalResult> {
    const requestedItem = typeof args.item === 'string' ? args.item.trim().toLowerCase() : 'wood';
    if (!['wood', 'log', 'logs', 'tree', 'oak_log'].includes(requestedItem)) {
      return { status: 'failed', detail: 'Gather supports logs from reachable trees only.' };
    }
    const quantity = Number(args.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 16) {
      return { status: 'failed', detail: 'Gather quantity must be between 1 and 16 logs.' };
    }
    let collected = 0;
    const collectedKinds = new Map<string, number>();
    const logCounts = () => bot.inventory.items()
      .filter((item) => item.name.endsWith('_log'))
      .reduce((total, item) => total + item.count, 0);

    while (collected < quantity) {
      if (signal.aborted) return { status: 'cancelled', detail: String(signal.reason ?? 'Cancelled by scheduler') };
      const logPosition = bot.findBlocks({
        matching: (block) => block.name.endsWith('_log'),
        maxDistance: 32,
        count: 16,
      })[0];
      if (!logPosition) {
        const detail = collected === 0 ? 'No reachable tree logs were found nearby.' : `Collected ${collected} of ${quantity} requested logs; no more reachable tree logs were found.`;
        return { status: 'failed', detail };
      }
      const route = await this.goto(bot, logPosition, 2, 'Reached a tree log.', signal);
      if (route.status !== 'completed') return route;
      if (signal.aborted) return { status: 'cancelled', detail: String(signal.reason ?? 'Cancelled by scheduler') };
      const block = bot.blockAt(logPosition);
      if (!block || !block.name.endsWith('_log') || !bot.canDigBlock(block)) {
        return { status: 'failed', detail: 'The nearby tree log is no longer safe or available to dig.' };
      }
      const before = logCounts();
      let droppedItem: EntityLike | undefined;
      const expectedItemId = bot.registry.itemsByName[block.name]?.id;
      const onItemDrop = (entity: EntityLike) => {
        if (entity.name !== 'item' || expectedItemId === undefined || !hasItemId(entity.metadata, expectedItemId)) return;
        const dropPosition = position(entity);
        if (!dropPosition) return;
        const dx = dropPosition.x - block.position.x;
        const dy = dropPosition.y - block.position.y;
        const dz = dropPosition.z - block.position.z;
        if (dx * dx + dy * dy + dz * dz <= 9) droppedItem = entity;
      };
      bot.on('itemDrop', onItemDrop);
      const digResult = new Promise<boolean>((resolve, reject) => {
        const onAbort = () => { bot.stopDigging(); resolve(true); };
        signal.addEventListener('abort', onAbort, { once: true });
        void bot.dig(block, true).then(
          () => { signal.removeEventListener('abort', onAbort); resolve(false); },
          (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
      });
      let wasCancelled: boolean;
      try {
        wasCancelled = await digResult;
      } catch (error) {
        return { status: 'failed', detail: error instanceof Error ? error.message : 'Minecraft could not dig the tree log.' };
      } finally {
        bot.removeListener('itemDrop', onItemDrop);
      }
      if (wasCancelled) return { status: 'cancelled', detail: String(signal.reason ?? 'Cancelled by scheduler') };
      if (signal.aborted) return { status: 'cancelled', detail: String(signal.reason ?? 'Cancelled by scheduler') };
      if (logCounts() <= before && droppedItem) {
        const pickup = await this.goto(bot, droppedItem.position, 0.5, 'Picked up a tree log.', signal);
        if (pickup.status !== 'completed') return pickup;
      }
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && logCounts() <= before && !signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (signal.aborted) return { status: 'cancelled', detail: String(signal.reason ?? 'Cancelled by scheduler') };
      if (logCounts() <= before) return { status: 'failed', detail: 'Broke a tree log but could not confirm picking up the wood.' };
      collected += 1;
      collectedKinds.set(block.name, (collectedKinds.get(block.name) ?? 0) + 1);
    }
    const summary = [...collectedKinds].map(([name, count]) => `${count} ${name.replace(/_log$/, ' log')}${count === 1 ? '' : 's'}`).join(', ');
    return { status: 'completed', detail: `Collected ${summary}.` };
  }

  private async give(bot: MineflayerBot, args: Record<string, unknown>, signal: AbortSignal): Promise<GoalResult> {
    const itemName = typeof args.item === 'string' ? args.item.trim().toLowerCase() : '';
    if (!itemName) return { status: 'failed', detail: 'Name the item to drop near the player.' };
    const requestedQuantity = Number(args.quantity ?? 1);
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) {
      return { status: 'failed', detail: 'Item quantity must be a positive whole number.' };
    }
    const targetName = this.playerTarget(args.target);
    if (!targetName) return { status: 'failed', detail: `Only configured player ${this.playerName} can receive items.` };
    const item = bot.inventory.items().find((entry) => entry.name.toLowerCase() === itemName);
    if (!item || item.type === undefined) return { status: 'failed', detail: `I do not have ${itemName} to drop.` };
    const count = Math.min(requestedQuantity, item.count);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = bot.players[targetName]?.entity;
      if (!target) return { status: 'failed', detail: `Player ${targetName} is not visible in the Minecraft world.` };
      const route = await this.goto(bot, target.position, 2, `Reached ${targetName}.`, signal);
      if (route.status !== 'completed') return route;
      if (signal.aborted) return { status: 'cancelled', detail: String(signal.reason ?? 'Cancelled by scheduler') };
      const currentTarget = position(bot.players[targetName]?.entity);
      const botPosition = position(bot.entity);
      if (!currentTarget || !botPosition) return { status: 'failed', detail: `Could not confirm ${targetName}'s current position.` };
      if (Math.hypot(currentTarget.x - botPosition.x, currentTarget.y - botPosition.y, currentTarget.z - botPosition.z) > 2) continue;
      try {
        await bot.toss(item.type, null, count);
        return { status: 'completed', detail: `Dropped ${count} ${itemName} near ${targetName}; they can pick it up.` };
      } catch (error) {
        return { status: 'failed', detail: error instanceof Error ? error.message : `Could not drop ${itemName}.` };
      }
    }
    return { status: 'failed', detail: `${targetName} moved while I approached; I did not drop the item.` };
  }

  private playerTarget(target: unknown): string | undefined {
    if (target === undefined) return this.playerName;
    if (typeof target !== 'string') return undefined;
    const requested = target.trim();
    if (!requested || ['me', 'myself', 'you', 'player', 'the player'].includes(requested.toLowerCase())) return this.playerName;
    return requested === this.playerName ? this.playerName : undefined;
  }

  private retreatTarget(bot: MineflayerBot): Vec3 | undefined {
    const spawn = this.safeSpawn;
    if (!spawn) return undefined;
    const x = Math.floor(spawn.x);
    const z = Math.floor(spawn.z);
    const baseY = Math.floor(spawn.y);
    const offsets = Array.from({ length: 33 }, (_, index) => index === 0 ? 0 : (index % 2 ? -(index + 1) / 2 : index / 2));
    const unsafeGround = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow']);
    const origin = bot.entity?.position;
    if (!origin) return undefined;
    const blockAt = (targetY: number) => bot.blockAt(origin.offset
      ? origin.offset(x - origin.x, targetY - origin.y, z - origin.z)
      : { x, y: targetY, z });
    for (const offset of offsets) {
      const y = baseY + offset;
      const support = blockAt(y - 1);
      const feet = blockAt(y);
      const head = blockAt(y + 1);
      if (support?.boundingBox === 'block' && !unsafeGround.has(support.name)
        && feet?.boundingBox === 'empty' && !unsafeGround.has(feet.name)
        && head?.boundingBox === 'empty' && !unsafeGround.has(head.name)) return { x, y, z };
    }
    return undefined;
  }

  private follow(bot: MineflayerBot, target: EntityLike, targetName: string, signal: AbortSignal): Promise<GoalResult> {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        bot.removeListener('end', onEnd);
      };
      const finish = (result: GoalResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => {
        this.stopNavigation(bot);
        finish({ status: 'cancelled', detail: String(signal.reason ?? 'Cancelled by scheduler') });
      };
      const onEnd = () => finish({ status: 'failed', detail: 'Minecraft disconnected while following.' });
      signal.addEventListener('abort', onAbort, { once: true });
      bot.once('end', onEnd);
      bot.pathfinder.setGoal(new this.runtime.goals.GoalFollow(target, this.followRange), true);
      if (signal.aborted) onAbort();
    });
  }

  private goto(bot: MineflayerBot, target: Vec3, range: number, detail: string, signal: AbortSignal): Promise<GoalResult> {
    const targetPosition = asPosition(target);
    if (!targetPosition) return Promise.resolve({ status: 'failed', detail: 'Minecraft target position is invalid.' });
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        bot.removeListener('end', onEnd);
      };
      const finish = (result: GoalResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => {
        this.stopNavigation(bot);
        finish({ status: 'cancelled', detail: String(signal.reason ?? 'Cancelled by scheduler') });
      };
      const onEnd = () => finish({ status: 'failed', detail: 'Minecraft disconnected during navigation.' });
      signal.addEventListener('abort', onAbort, { once: true });
      bot.once('end', onEnd);
      const goal = new this.runtime.goals.GoalNear(targetPosition.x, targetPosition.y, targetPosition.z, range);
      void bot.pathfinder.goto(goal).then(
        () => finish({ status: 'completed', detail }),
        (error: unknown) => finish(signal.aborted
          ? { status: 'cancelled', detail: String(signal.reason ?? 'Cancelled by scheduler') }
          : { status: 'failed', detail: error instanceof Error ? error.message : 'Minecraft navigation failed.' }),
      );
      if (signal.aborted) onAbort();
    });
  }
}

function hasItemId(value: unknown, expectedId: number): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasItemId(entry, expectedId));
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.itemId === expectedId) return true;
  return Object.values(record).some((entry) => hasItemId(entry, expectedId));
}

/** Load the pinned runtime packages only in the live adapter process. */
export async function loadMinecraftAdapter(options: MinecraftAdapterOptions = {}): Promise<MinecraftAdapter> {
  const [mineflayerModule, pathfinderModule] = await Promise.all([
    import('mineflayer'),
    import('mineflayer-pathfinder'),
  ]);
  const mineflayer = mineflayerModule.default ?? mineflayerModule;
  const pathfinder = pathfinderModule.default ?? pathfinderModule;
  const runtime: MinecraftRuntime = {
    createBot: mineflayer.createBot as unknown as MinecraftRuntime['createBot'],
    pathfinderPlugin: pathfinder.pathfinder,
    Movements: pathfinder.Movements as unknown as MinecraftRuntime['Movements'],
    goals: pathfinder.goals as unknown as MinecraftRuntime['goals'],
  };
  if (typeof runtime.createBot !== 'function' || typeof runtime.pathfinderPlugin !== 'function'
    || typeof runtime.Movements !== 'function'
    || typeof runtime.goals?.GoalFollow !== 'function' || typeof runtime.goals?.GoalNear !== 'function') {
    throw new TypeError('Installed Mineflayer pathfinder packages do not expose the required runtime APIs');
  }
  return new MinecraftAdapter(runtime, options);
}
