import { projectCompletedNativeReactionSpeech, type NativeReactionHearingEvent } from './village-native-reaction-perception.ts';
import { ResidentNativeReactionPolicy, type NativeReactionOrigin, type ReactionEnqueueResult, type ScheduledNativeReaction } from './village-native-reaction-policy.ts';
import type { NativeSpeechPositionSample } from './village-spoken-perception.ts';

const MAX_NATIVE_SPEECH_SAMPLES = 500;
const MAX_TERMINAL_REACTIONS = 512;
const SAFE_REACTION_ID = /^[A-Za-z0-9_-]{8,128}$/;

function eventKey(residentId: string, eventId: string): string {
  return `${residentId}:${eventId}`;
}

export interface NativeReactionCandidateEvent extends ScheduledNativeReaction {
  version: 1;
  type: 'village.native.reaction';
}

export type NativeReactionEngineCommand =
  | {
    version: 1;
    type: 'ptt.reaction.ack';
    eventId: string;
    residentId: string;
    reactionId?: string;
    status: 'accepted' | 'busy' | 'unavailable';
    at: number;
  }
  | {
    version: 1;
    type: 'ptt.reaction.speech.start';
    eventId: string;
    residentId: string;
    reactionId: string;
    responseId: string;
    itemId: string;
    at: number;
  }
  | {
    version: 1;
    type: 'ptt.reaction.speech.finish';
    eventId: string;
    residentId: string;
    reactionId: string;
    responseId: string;
    itemId: string;
    playback: 'completed' | 'interrupted';
    transcript?: string;
    at: number;
  };

export type NativeReactionEngineAck =
  | {
    version: 1;
    type: 'ptt.reaction.ack';
    eventId: string;
    residentId: string;
    reactionId?: string;
    status: 'accepted' | 'busy' | 'unavailable';
    at: number;
  }
  | {
    version: 1;
    type: 'ptt.reaction.speech.ack';
    eventId: string;
    residentId: string;
    reactionId: string;
    responseId: string;
    itemId: string;
    status: 'started' | 'finished' | 'interrupted' | 'duplicate' | 'unavailable';
    at: number;
  };

export interface NewlyHeardSpeechEvent {
  eventId: string;
  speakerId: string;
  text: string;
  recipientIds: readonly string[];
  completedAtTick: number;
}

type ActiveReaction = {
  scheduled: ScheduledNativeReaction;
  reactionId?: string;
  speech?: {
    responseId: string;
    itemId: string;
    samples: NativeSpeechPositionSample[];
    samplingComplete: boolean;
  };
};

interface NativeResidentReactionCoordinatorOptions {
  now?: () => number;
  policy?: ResidentNativeReactionPolicy;
  emitCandidate: (candidate: NativeReactionCandidateEvent) => void;
  samplePlayback: (residentId: string) => NativeSpeechPositionSample | null;
  rememberHeardSpeech: (event: NewlyHeardSpeechEvent, speakerName: string) => void;
  residentName: (residentId: string) => string | undefined;
}

/** Engine-owned event lifecycle for resident reactions; transport only supplies correlation and playback reports. */
export class NativeResidentReactionCoordinator {
  readonly #policy: ResidentNativeReactionPolicy;
  readonly #now: () => number;
  readonly #emitCandidate: NativeResidentReactionCoordinatorOptions['emitCandidate'];
  readonly #samplePlayback: NativeResidentReactionCoordinatorOptions['samplePlayback'];
  readonly #rememberHeardSpeech: NativeResidentReactionCoordinatorOptions['rememberHeardSpeech'];
  readonly #residentName: NativeResidentReactionCoordinatorOptions['residentName'];
  readonly #activeByEventId = new Map<string, ActiveReaction>();
  readonly #activeByReactionId = new Map<string, ActiveReaction>();
  readonly #busyResidents = new Set<string>();
  readonly #terminalByReactionId = new Map<string, NativeReactionEngineAck>();
  readonly #consumedReactionIds = new Set<string>();

  constructor(options: NativeResidentReactionCoordinatorOptions) {
    this.#policy = options.policy ?? new ResidentNativeReactionPolicy();
    this.#now = options.now ?? Date.now;
    this.#emitCandidate = options.emitCandidate;
    this.#samplePlayback = options.samplePlayback;
    this.#rememberHeardSpeech = options.rememberHeardSpeech;
    this.#residentName = options.residentName;
  }

  get activeCount(): number {
    return this.#policy.activeCount;
  }

  routineEntered(input: {
    eventId: string;
    residentId: string;
    activity: string;
    motivation: string;
    at?: number;
  }): ReactionEnqueueResult {
    const result = this.#policy.enqueue({
      ...input,
      kind: 'routine',
      at: input.at ?? this.#now(),
    });
    this.#pump();
    return result;
  }

  /** Enqueues only the newly projected event supplied by the engine; never scans historical heard memory. */
  heardSpeech(
    event: NewlyHeardSpeechEvent,
    options: { speakerName: string; origin: Exclude<NativeReactionOrigin, 'routine'>; causalDepth?: number },
  ): readonly ReactionEnqueueResult[] {
    const results = event.recipientIds.map((residentId) => this.#policy.enqueue({
      eventId: event.eventId,
      residentId,
      kind: 'heard',
      at: event.completedAtTick,
      speakerId: event.speakerId,
      speakerName: options.speakerName,
      text: event.text,
      origin: options.origin,
      ...(options.origin === 'native-reaction' ? { causalDepth: options.causalDepth } : {}),
    }));
    this.#pump();
    return results;
  }

  setResidentBusy(residentId: string, busy: boolean): void {
    if (busy) this.#busyResidents.add(residentId);
    else this.#busyResidents.delete(residentId);
    this.#pump();
  }

  sampleActivePlayback(): void {
    for (const active of this.#activeByEventId.values()) {
      const speech = active.speech;
      if (!speech || !speech.samplingComplete) continue;
      const sample = this.#samplePlayback(active.scheduled.residentId);
      if (!sample || speech.samples.length >= MAX_NATIVE_SPEECH_SAMPLES) {
        speech.samplingComplete = false;
        continue;
      }
      speech.samples.push(sample);
    }
  }

  handle(command: NativeReactionEngineCommand): NativeReactionEngineAck {
    if (command.type === 'ptt.reaction.ack') return this.#handleDispatchAck(command);
    if (command.type === 'ptt.reaction.speech.start') return this.#handleSpeechStart(command);
    return this.#handleSpeechFinish(command);
  }

  /** Expire unanswered dispatches and return capacity to the global scheduler. */
  tick(now = this.#now()): void {
    this.#pump(now);
  }

  #handleDispatchAck(command: Extract<NativeReactionEngineCommand, { type: 'ptt.reaction.ack' }>): NativeReactionEngineAck {
    const active = this.#activeByEventId.get(eventKey(command.residentId, command.eventId));
    if (!active || active.scheduled.residentId !== command.residentId) {
      const terminal = command.reactionId ? this.#terminalByReactionId.get(command.reactionId) : undefined;
      if (terminal?.type === 'ptt.reaction.ack' && terminal.eventId === command.eventId
        && terminal.residentId === command.residentId) return terminal;
      return this.#dispatchAck(command, 'unavailable');
    }
    if (command.reactionId && !SAFE_REACTION_ID.test(command.reactionId)) {
      this.#release(active, true);
      return this.#dispatchAck(command, 'unavailable');
    }
    if (command.status !== 'unavailable' && !command.reactionId) {
      this.#release(active, true);
      return this.#dispatchAck(command, 'unavailable');
    }
    if (command.reactionId && active.reactionId && active.reactionId !== command.reactionId) {
      return this.#dispatchAck(command, 'unavailable');
    }
    if (command.reactionId) {
      const other = this.#activeByReactionId.get(command.reactionId);
      if (other && other !== active) return this.#dispatchAck(command, 'unavailable');
    }

    if (command.status === 'accepted') {
      active.reactionId = command.reactionId;
      this.#activeByReactionId.set(command.reactionId!, active);
    } else {
      this.#release(active, command.status === 'unavailable');
      if (command.status === 'busy') this.#busyResidents.add(command.residentId);
      const reactionId = command.reactionId ?? active.reactionId;
      if (reactionId) this.#rememberTerminal(reactionId, this.#dispatchAck(command, command.status, reactionId));
    }
    const ack = this.#dispatchAck(command, command.status, command.reactionId ?? active.reactionId);
    this.#pump();
    return ack;
  }

  #handleSpeechStart(command: Extract<NativeReactionEngineCommand, { type: 'ptt.reaction.speech.start' }>): NativeReactionEngineAck {
    const active = this.#activeByReactionId.get(command.reactionId);
    if (!active || !this.#matches(active, command)) {
      const terminal = this.#terminalByReactionId.get(command.reactionId);
      if (terminal && terminal.type === 'ptt.reaction.speech.ack' && this.#matchesTerminal(terminal, command)) return terminal;
      return this.#speechAck(command, 'unavailable');
    }
    if (active.speech) {
      const sameItem = active.speech.responseId === command.responseId && active.speech.itemId === command.itemId;
      return this.#speechAck(command, sameItem ? 'duplicate' : 'unavailable');
    }
    const firstSample = this.#samplePlayback(command.residentId);
    if (!firstSample) {
      this.#release(active, true);
      const ack = this.#speechAck(command, 'unavailable');
      this.#rememberTerminal(command.reactionId, ack);
      this.#pump();
      return ack;
    }
    active.speech = {
      responseId: command.responseId,
      itemId: command.itemId,
      samples: [firstSample],
      samplingComplete: true,
    };
    return this.#speechAck(command, 'started');
  }

  #handleSpeechFinish(command: Extract<NativeReactionEngineCommand, { type: 'ptt.reaction.speech.finish' }>): NativeReactionEngineAck {
    const active = this.#activeByReactionId.get(command.reactionId);
    if (!active || !this.#matches(active, command) || !active.speech
      || active.speech.responseId !== command.responseId || active.speech.itemId !== command.itemId) {
      const terminal = this.#terminalByReactionId.get(command.reactionId);
      if (terminal && terminal.type === 'ptt.reaction.speech.ack' && this.#matchesTerminal(terminal, command)) return terminal;
      return this.#speechAck(command, 'unavailable');
    }

    const speech = active.speech;
    const finalSample = this.#samplePlayback(command.residentId);
    if (!finalSample || speech.samples.length >= MAX_NATIVE_SPEECH_SAMPLES) speech.samplingComplete = false;
    else speech.samples.push(finalSample);

    const event = command.playback === 'completed'
      ? projectCompletedNativeReactionSpeech({
        reaction: {
          reactionId: command.reactionId,
          eventId: command.eventId,
          residentId: command.residentId,
          responseId: command.responseId,
          itemId: command.itemId,
          causalDepth: active.scheduled.causalDepth,
        },
        report: {
          reactionId: command.reactionId,
          eventId: command.eventId,
          residentId: command.residentId,
          responseId: command.responseId,
          itemId: command.itemId,
          playback: command.playback,
          ...(command.transcript ? { transcript: command.transcript } : {}),
        },
        samples: speech.samplingComplete ? speech.samples : [],
        consumedReactionIds: this.#consumedReactionIds,
      })
      : null;

    if (command.playback === 'completed') this.#policy.complete(command.residentId, command.eventId, command.at);
    else this.#policy.release(command.residentId, command.eventId);
    this.#removeActive(active);

    const ack = this.#speechAck(command, command.playback === 'completed' ? 'finished' : 'interrupted');
    this.#rememberTerminal(command.reactionId, ack);
    if (event) {
      const speakerName = this.#residentName(event.speakerId);
      if (speakerName) {
        this.#rememberHeardSpeech(event, speakerName);
        this.heardSpeech(event, { speakerName, origin: 'native-reaction', causalDepth: event.causalDepth });
      }
    }
    this.#pump();
    return ack;
  }

  #pump(now = this.#now()): void {
    const expired = this.#policy.prune(now);
    for (const { residentId, eventId } of expired) {
      const active = this.#activeByEventId.get(eventKey(residentId, eventId));
      if (!active) continue;
      this.#policy.clearPending(residentId);
      this.#removeActive(active);
    }
    while (true) {
      const scheduled = this.#policy.takeNextAny(now, this.#busyResidents);
      if (!scheduled) return;
      const active: ActiveReaction = { scheduled };
      this.#activeByEventId.set(eventKey(scheduled.residentId, scheduled.eventId), active);
      try {
        this.#emitCandidate({ version: 1, type: 'village.native.reaction', ...scheduled });
      } catch (error) {
        this.#release(active, false);
        throw error;
      }
    }
  }

  #release(active: ActiveReaction, dropPending: boolean): void {
    this.#policy.release(active.scheduled.residentId, active.scheduled.eventId);
    if (dropPending) this.#policy.clearPending(active.scheduled.residentId);
    this.#removeActive(active);
  }

  #removeActive(active: ActiveReaction): void {
    this.#activeByEventId.delete(eventKey(active.scheduled.residentId, active.scheduled.eventId));
    if (active.reactionId) this.#activeByReactionId.delete(active.reactionId);
  }

  #matches(active: ActiveReaction, command: { eventId: string; residentId: string; reactionId: string }): boolean {
    return active.scheduled.eventId === command.eventId
      && active.scheduled.residentId === command.residentId
      && active.reactionId === command.reactionId;
  }

  #dispatchAck(
    command: Extract<NativeReactionEngineCommand, { type: 'ptt.reaction.ack' }>,
    status: 'accepted' | 'busy' | 'unavailable',
    reactionId = command.reactionId,
  ): NativeReactionEngineAck {
    return {
      version: 1,
      type: 'ptt.reaction.ack',
      eventId: command.eventId,
      residentId: command.residentId,
      ...(reactionId ? { reactionId } : {}),
      status,
      at: this.#now(),
    };
  }

  #speechAck(
    command: Extract<NativeReactionEngineCommand, { type: 'ptt.reaction.speech.start' | 'ptt.reaction.speech.finish' }>
      | ActiveReaction,
    status: 'started' | 'finished' | 'interrupted' | 'duplicate' | 'unavailable',
    at = this.#now(),
  ): NativeReactionEngineAck {
    if ('scheduled' in command) {
      return {
        version: 1,
        type: 'ptt.reaction.speech.ack',
        eventId: command.scheduled.eventId,
        residentId: command.scheduled.residentId,
        reactionId: command.reactionId ?? '',
        responseId: command.speech?.responseId ?? '',
        itemId: command.speech?.itemId ?? '',
        status,
        at,
      };
    }
    return {
      version: 1,
      type: 'ptt.reaction.speech.ack',
      eventId: command.eventId,
      residentId: command.residentId,
      reactionId: command.reactionId,
      responseId: command.responseId,
      itemId: command.itemId,
      status,
      at,
    };
  }

  #matchesTerminal(
    terminal: Extract<NativeReactionEngineAck, { type: 'ptt.reaction.speech.ack' }>,
    command: Extract<NativeReactionEngineCommand, { type: 'ptt.reaction.speech.start' | 'ptt.reaction.speech.finish' }>,
  ): boolean {
    return terminal.reactionId === command.reactionId && terminal.eventId === command.eventId
      && terminal.residentId === command.residentId && terminal.responseId === command.responseId
      && terminal.itemId === command.itemId;
  }

  #rememberTerminal(reactionId: string, ack: NativeReactionEngineAck): void {
    this.#terminalByReactionId.set(reactionId, ack);
    while (this.#terminalByReactionId.size > MAX_TERMINAL_REACTIONS) {
      const oldest = this.#terminalByReactionId.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#terminalByReactionId.delete(oldest);
    }
  }
}
