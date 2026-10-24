export type ResidentNativeReaction =
  | {
    eventId: string;
    residentId: string;
    kind: 'routine';
    at: number;
    activity: string;
    motivation: string;
    origin?: 'routine';
    causalDepth?: 0;
  }
  | {
    eventId: string;
    residentId: string;
    kind: 'heard';
    at: number;
    speakerId: string;
    speakerName: string;
    text: string;
    origin?: 'player' | 'resident' | 'native-reaction';
    causalDepth?: number;
  };

export type NativeReactionOrigin = 'routine' | 'player' | 'resident' | 'native-reaction';

export interface ScheduledNativeReaction {
  eventId: string;
  residentId: string;
  origin: NativeReactionOrigin;
  context: string;
  causalDepth: number;
  createdAt: number;
  expiresAt: number;
}

export type ReactionEnqueueResult =
  | { status: 'queued'; displacedEventId?: string }
  | { status: 'duplicate' | 'self-heard' | 'reaction-chain-limit' | 'queue-full' | 'invalid' };

export interface ExpiredNativeReaction {
  residentId: string;
  eventId: string;
}

type ActiveReaction = {
  eventId: string;
  expiresAt: number;
};

type ResidentState = {
  pending: ResidentNativeReaction[];
  active?: ActiveReaction;
  lastCompletedAt?: number;
  seen: Map<string, number>;
};

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_RESIDENT_ID_BYTES = 64;
const MAX_CONTEXT_BYTES = 1_000;
const MAX_SEEN_EVENTS_PER_RESIDENT = 128;

function boundedText(value: string, maxBytes: number): string {
  let result = '';
  let byteCount = 0;
  for (const character of value) {
    if (/[\u0000-\u001f\u007f]/.test(character)) continue;
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteCount + characterBytes > maxBytes) break;
    result += character;
    byteCount += characterBytes;
  }
  return result.trim();
}

function isValidReaction(reaction: ResidentNativeReaction): boolean {
  if (!SAFE_ID.test(reaction.eventId) || Buffer.byteLength(reaction.residentId, 'utf8') > MAX_RESIDENT_ID_BYTES
    || !SAFE_ID.test(reaction.residentId) || !Number.isSafeInteger(reaction.at) || reaction.at < 0) return false;
  if (reaction.kind === 'routine') {
    return (reaction.origin === undefined || reaction.origin === 'routine')
      && (reaction.causalDepth === undefined || reaction.causalDepth === 0)
      && boundedText(reaction.activity, 240).length > 0
      && boundedText(reaction.motivation, 240).length > 0;
  }
  return (reaction.origin === undefined || reaction.origin === 'player' || reaction.origin === 'resident' || reaction.origin === 'native-reaction')
    && (reaction.causalDepth === undefined || (Number.isSafeInteger(reaction.causalDepth) && reaction.causalDepth >= 0 && reaction.causalDepth <= 2))
    && (reaction.origin !== 'native-reaction' || reaction.causalDepth !== undefined)
    && SAFE_ID.test(reaction.speakerId)
    && boundedText(reaction.speakerName, 80).length > 0
    && boundedText(reaction.text, 700).length > 0;
}

function contextFor(reaction: ResidentNativeReaction): string {
  const text = reaction.kind === 'routine'
    ? `You are currently ${boundedText(reaction.activity, 240)}. This follows your ordinary motivation: ${boundedText(reaction.motivation, 240)}. Say one brief spontaneous line that fits what you are doing; do not invent new facts or claim to have changed the world.`
    : `You just heard ${boundedText(reaction.speakerName, 80)} say: “${boundedText(reaction.text, 700)}” Treat this as that speaker’s unverified claim, not established truth. Respond naturally in one brief line if you have something to add.`;
  return boundedText(text, MAX_CONTEXT_BYTES);
}

function priority(reaction: ResidentNativeReaction): number {
  return reaction.kind === 'heard' ? 2 : 1;
}

function compareReactions(left: ResidentNativeReaction, right: ResidentNativeReaction): number {
  return priority(right) - priority(left) || left.at - right.at || left.eventId.localeCompare(right.eventId);
}

/** Bounded policy for prioritizing and admitting native resident reactions. */
export class ResidentNativeReactionPolicy {
  readonly #states = new Map<string, ResidentState>();
  readonly #maxQueuedPerResident: number;
  readonly #maxActive: number;
  readonly #eventTtlMs: number;
  readonly #cooldownMs: number;

  constructor(options: {
    maxQueuedPerResident?: number;
    maxActive?: number;
    eventTtlMs?: number;
    cooldownMs?: number;
  } = {}) {
    this.#maxQueuedPerResident = Math.max(1, Math.min(8, options.maxQueuedPerResident ?? 2));
    this.#maxActive = Math.max(1, Math.min(12, options.maxActive ?? 3));
    this.#eventTtlMs = Math.max(1_000, Math.min(60_000, options.eventTtlMs ?? 30_000));
    this.#cooldownMs = Math.max(0, Math.min(120_000, options.cooldownMs ?? 15_000));
  }

  get activeCount(): number {
    return [...this.#states.values()].filter(({ active }) => active !== undefined).length;
  }

  enqueue(reaction: ResidentNativeReaction): ReactionEnqueueResult {
    if (!isValidReaction(reaction)) return { status: 'invalid' };
    if (reaction.kind === 'heard' && reaction.speakerId === reaction.residentId) return { status: 'self-heard' };
    if (reaction.origin === 'native-reaction' && (reaction.causalDepth ?? 0) >= 2) return { status: 'reaction-chain-limit' };

    const state = this.#state(reaction.residentId);
    this.#pruneSeen(state, reaction.at);
    state.pending = state.pending.filter(({ at }) => at + this.#eventTtlMs > reaction.at);
    if (state.seen.has(reaction.eventId)) return { status: 'duplicate' };

    let displacedEventId: string | undefined;
    if (state.pending.length >= this.#maxQueuedPerResident) {
      const lowestPriority = Math.min(...state.pending.map(priority));
      if (priority(reaction) <= lowestPriority) {
        state.seen.set(reaction.eventId, reaction.at + this.#eventTtlMs);
        this.#boundSeen(state);
        return { status: 'queue-full' };
      }
      const displacedIndex = state.pending
        .map((pending, index) => ({ pending, index }))
        .filter(({ pending }) => priority(pending) === lowestPriority)
        .sort((left, right) => right.pending.at - left.pending.at || right.pending.eventId.localeCompare(left.pending.eventId))[0]!.index;
      const [displaced] = state.pending.splice(displacedIndex, 1);
      displacedEventId = displaced!.eventId;
    }

    state.seen.set(reaction.eventId, reaction.at + this.#eventTtlMs);
    this.#boundSeen(state);
    state.pending.push(reaction);
    return { status: 'queued', ...(displacedEventId ? { displacedEventId } : {}) };
  }

  takeNextAny(now = Date.now()): ScheduledNativeReaction | null {
    this.prune(now);
    if (this.activeCount >= this.#maxActive) return null;
    const choices = [...this.#states.entries()]
      .filter(([, state]) => !state.active && state.pending.length > 0
        && (state.lastCompletedAt === undefined || now - state.lastCompletedAt >= this.#cooldownMs))
      .map(([residentId, state]) => ({ residentId, state, next: [...state.pending].sort(compareReactions)[0]! }))
      .sort((left, right) => compareReactions(left.next, right.next) || left.residentId.localeCompare(right.residentId));
    const selected = choices[0];
    return selected ? this.#take(selected.residentId, selected.state, selected.next, now) : null;
  }

  takeNextFor(residentId: string, now = Date.now()): ScheduledNativeReaction | null {
    this.prune(now);
    if (this.activeCount >= this.#maxActive) return null;
    const state = this.#states.get(residentId);
    if (!state || state.active || state.pending.length === 0
      || (state.lastCompletedAt !== undefined && now - state.lastCompletedAt < this.#cooldownMs)) return null;
    const next = [...state.pending].sort(compareReactions)[0]!;
    return this.#take(residentId, state, next, now);
  }

  complete(residentId: string, eventId: string, now = Date.now()): boolean {
    const state = this.#states.get(residentId);
    if (!state || state.active?.eventId !== eventId) return false;
    state.active = undefined;
    state.lastCompletedAt = now;
    return true;
  }

  release(residentId: string, eventId: string): boolean {
    const state = this.#states.get(residentId);
    if (!state || state.active?.eventId !== eventId) return false;
    state.active = undefined;
    return true;
  }

  clearPending(residentId: string): number {
    const state = this.#states.get(residentId);
    if (!state) return 0;
    const dropped = state.pending.length;
    state.pending = [];
    return dropped;
  }

  prune(now = Date.now()): ExpiredNativeReaction[] {
    const expired: ExpiredNativeReaction[] = [];
    for (const [residentId, state] of this.#states) {
      state.pending = state.pending.filter(({ at }) => at + this.#eventTtlMs > now);
      this.#pruneSeen(state, now);
      if (state.active && state.active.expiresAt <= now) {
        expired.push({ residentId, eventId: state.active.eventId });
        state.active = undefined;
      }
      if (state.pending.length === 0 && !state.active && state.seen.size === 0 && state.lastCompletedAt === undefined) {
        this.#states.delete(residentId);
      }
    }
    return expired;
  }

  #take(
    residentId: string,
    state: ResidentState,
    next: ResidentNativeReaction,
    now: number,
  ): ScheduledNativeReaction {
    state.pending = state.pending.filter(({ eventId }) => eventId !== next.eventId);
    const origin: NativeReactionOrigin = next.kind === 'routine' ? 'routine' : next.origin ?? 'resident';
    const causalDepth = next.kind === 'heard' && origin === 'native-reaction' ? (next.causalDepth ?? 0) + 1 : 1;
    const expiresAt = now + this.#eventTtlMs;
    state.active = { eventId: next.eventId, expiresAt };
    return {
      eventId: next.eventId,
      residentId,
      origin,
      context: contextFor(next),
      causalDepth,
      createdAt: next.at,
      expiresAt,
    };
  }

  #state(residentId: string): ResidentState {
    let state = this.#states.get(residentId);
    if (!state) {
      state = { pending: [], seen: new Map() };
      this.#states.set(residentId, state);
    }
    return state;
  }

  #pruneSeen(state: ResidentState, now: number): void {
    for (const [eventId, expiresAt] of state.seen) if (expiresAt <= now) state.seen.delete(eventId);
  }

  #boundSeen(state: ResidentState): void {
    while (state.seen.size > MAX_SEEN_EVENTS_PER_RESIDENT) state.seen.delete(state.seen.keys().next().value!);
  }
}
