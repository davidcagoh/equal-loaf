interface AttributedSpeechPerception {
  eventId: string;
  speakerId: string;
  text: string;
  recipientIds: readonly string[];
  completedAtTick: number;
}

export interface HeardSpeechContext {
  eventId: string;
  speakerId: string;
  speakerName: string;
  text: string;
  tick: number;
  expiresAt: number;
}

/** In-memory, resident-scoped hearsay context; this class has no disk or logging path. */
export class VillageHeardSpeechMemory {
  readonly #byResident = new Map<string, HeardSpeechContext[]>();
  readonly #maxPerResident: number;
  readonly #ttlMs: number;

  constructor(
    maxPerResident = 3,
    ttlMs = 180_000,
  ) {
    this.#maxPerResident = maxPerResident;
    this.#ttlMs = ttlMs;
  }

  remember(event: AttributedSpeechPerception, speakerName: string): number {
    let delivered = 0;
    for (const residentId of event.recipientIds) {
      if (residentId === event.speakerId) continue;
      const current = this.#prune(residentId, event.completedAtTick);
      this.#byResident.set(residentId, [...current, {
        eventId: event.eventId,
        speakerId: event.speakerId,
        speakerName,
        text: event.text,
        tick: event.completedAtTick,
        expiresAt: event.completedAtTick + this.#ttlMs,
      }].slice(-this.#maxPerResident));
      delivered += 1;
    }
    return delivered;
  }

  recent(residentId: string, now = Date.now()): readonly Omit<HeardSpeechContext, 'expiresAt'>[] {
    return this.#prune(residentId, now).map(({ expiresAt: _expiresAt, ...heard }) => heard);
  }

  prune(now = Date.now()): void {
    for (const residentId of this.#byResident.keys()) this.#prune(residentId, now);
  }

  clear(): void {
    this.#byResident.clear();
  }

  #prune(residentId: string, now: number): HeardSpeechContext[] {
    const current = (this.#byResident.get(residentId) ?? []).filter((heard) => heard.expiresAt > now);
    if (current.length === 0) this.#byResident.delete(residentId);
    else this.#byResident.set(residentId, current);
    return current;
  }
}
