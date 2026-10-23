import { EventEmitter } from 'node:events';
import type { GameAdapter, Goal, GoalKind, GoalResult, Observation } from '../../contracts/src/index.ts';

interface Vec3 { x: number; y: number; z: number }
interface EntityLike { position: Vec3; health?: number; username?: string; type?: string }
interface PlayerLike { entity?: EntityLike }
interface PathfinderLike {
  setMovements(movements: unknown): void;
  setGoal(goal: unknown | null, dynamic?: boolean): void;
  goto(goal: unknown): Promise<void>;
}

export interface MineflayerBot extends EventEmitter {
  username: string;
  entity?: EntityLike;
  players: Record<string, PlayerLike>;
  inventory: { items(): Array<{ name: string; count: number }> };
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

const supportedKinds: readonly GoalKind[] = ['follow', 'stop', 'approach', 'retreat', 'report'];
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
    const inventory = Object.fromEntries(bot.inventory.items().map((item) => [item.name, item.count]));
    return {
      timestamp: Date.now(),
      game: 'minecraft',
      ...(playerPosition ? { player: { position: [playerPosition.x, playerPosition.y, playerPosition.z] as [number, number, number] } } : {}),
      agent: {
        position: [agentPosition.x, agentPosition.y, agentPosition.z],
        ...(typeof bot.entity?.health === 'number' ? { health: bot.entity.health } : {}),
      },
      inventory,
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
      return { status: 'completed', detail: `${playerState}${health}` };
    }
    if (goal.kind === 'follow' || goal.kind === 'approach') {
      const targetName = typeof goal.args.target === 'string' ? goal.args.target : this.playerName;
      if (targetName !== this.playerName) return { status: 'failed', detail: `Only configured player ${this.playerName} can be followed.` };
      const target = bot.players[targetName]?.entity;
      if (!target) return { status: 'failed', detail: `Player ${targetName} is not visible in the Minecraft world.` };
      return goal.kind === 'follow'
        ? this.follow(bot, target, targetName, signal)
        : this.goto(bot, target.position, this.followRange, `Approached ${targetName}.`, signal);
    }
    const spawn = this.safeSpawn;
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
