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

export interface ScheduledNativeReaction {
  eventId: string;
  residentId: string;
  context: string;
  causalDepth: number;
}

type ResidentState = {
  pending: ResidentNativeReaction[];
  activeEventId?: string;
  lastCompletedAt?: number;
  seen: Map<string, number>;
};

export type ReactionEnqueueResult =
  | { status: 'queued' }
  | { status: 'duplicate' | 'self-heard' | 'reaction-chain-limit' | 'queue-full' | 'invalid' };

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
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
  if (!SAFE_ID.test(reaction.eventId) || !SAFE_ID.test(reaction.residentId)
    || !Number.isSafeInteger(reaction.at) || reaction.at < 0) return false;
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

/**
 * Per-resident queue for unsolicited native speech. Each resident has independent
 * active/cooldown state, so one speaking voice never globally locks the village.
 */
export class ResidentNativeReactionScheduler {
  readonly #states = new Map<string, ResidentState>();
  readonly #maxQueuedPerResident: number;
  readonly #eventTtlMs: number;
  readonly #cooldownMs: number;

  constructor(options: { maxQueuedPerResident?: number; eventTtlMs?: number; cooldownMs?: number } = {}) {
    this.#maxQueuedPerResident = Math.max(1, Math.min(8, options.maxQueuedPerResident ?? 2));
    this.#eventTtlMs = Math.max(1_000, Math.min(60_000, options.eventTtlMs ?? 30_000));
    this.#cooldownMs = Math.max(0, Math.min(120_000, options.cooldownMs ?? 15_000));
  }

  enqueue(reaction: ResidentNativeReaction): ReactionEnqueueResult {
    if (!isValidReaction(reaction)) return { status: 'invalid' };
    if (reaction.kind === 'heard' && reaction.speakerId === reaction.residentId) return { status: 'self-heard' };
    if (reaction.origin === 'native-reaction' && (reaction.causalDepth ?? 0) >= 2) return { status: 'reaction-chain-limit' };

    const state = this.#state(reaction.residentId);
    this.#pruneSeen(state, reaction.at);
    state.pending = state.pending.filter(({ at }) => at + this.#eventTtlMs > reaction.at);
    if (state.seen.has(reaction.eventId)) return { status: 'duplicate' };
    if (state.pending.length >= this.#maxQueuedPerResident) return { status: 'queue-full' };
    state.seen.set(reaction.eventId, reaction.at + this.#eventTtlMs);
    while (state.seen.size > MAX_SEEN_EVENTS_PER_RESIDENT) state.seen.delete(state.seen.keys().next().value!);
    state.pending.push(reaction);
    return { status: 'queued' };
  }

  takeNext(residentId: string, now = Date.now()): ScheduledNativeReaction | null {
    const state = this.#states.get(residentId);
    if (!state || state.activeEventId || (state.lastCompletedAt !== undefined && now - state.lastCompletedAt < this.#cooldownMs)) return null;
    while (state.pending.length > 0) {
      const next = state.pending.shift()!;
      if (next.at + this.#eventTtlMs <= now) continue;
      state.activeEventId = next.eventId;
      return {
        eventId: next.eventId,
        residentId,
        context: contextFor(next),
        causalDepth: next.kind === 'heard' && next.origin === 'native-reaction' ? (next.causalDepth ?? 0) + 1 : 1,
      };
    }
    return null;
  }

  complete(residentId: string, eventId: string, now = Date.now()): boolean {
    const state = this.#states.get(residentId);
    if (!state || state.activeEventId !== eventId) return false;
    state.activeEventId = undefined;
    state.lastCompletedAt = now;
    return true;
  }

  release(residentId: string, eventId: string): boolean {
    const state = this.#states.get(residentId);
    if (!state || state.activeEventId !== eventId) return false;
    state.activeEventId = undefined;
    return true;
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
}
