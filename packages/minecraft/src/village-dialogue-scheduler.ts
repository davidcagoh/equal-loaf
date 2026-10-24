import type { DialogueTurn } from './village-profiles.ts';
import { isPublicObservableFactId, VILLAGE_FACTS, type VillageObservation } from './village-cognition.ts';

type ResidentUtteranceObservation = Extract<VillageObservation, { type: 'resident.utterance' }>;

export interface ResidentDialogueCursor {
  nextIndex: number;
}

export interface ScheduledResidentTurn {
  turn: DialogueTurn & { clueId?: string };
  cursor: ResidentDialogueCursor;
}

/** Advances one resident's authored public turns without sharing state or movement goals. */
export function nextResidentDialogueTurn(
  residentId: string,
  turns: readonly (DialogueTurn & { clueId?: string })[],
  cursor: ResidentDialogueCursor,
): ScheduledResidentTurn | null {
  const residentTurns = turns.filter(({ speakerId, clueId }) => speakerId === residentId &&
    (clueId === undefined || isPublicObservableFactId(clueId)));
  if (residentTurns.length === 0) return null;
  const index = ((cursor.nextIndex % residentTurns.length) + residentTurns.length) % residentTurns.length;
  return {
    turn: residentTurns[index]!,
    cursor: { nextIndex: index + 1 },
  };
}

export function createAmbientUtteranceObservation(input: {
  eventId: string;
  tick: number;
  speakerId: string;
  turn: DialogueTurn & { clueId?: string };
  speakerPosition: { x: number; y: number; z: number };
  residents: readonly { id: string; position: { x: number; y: number; z: number } }[];
  hearingRadius: number;
}): ResidentUtteranceObservation | null {
  const recipientIds = input.residents.filter(({ id, position }) => id !== input.speakerId &&
    Math.hypot(position.x - input.speakerPosition.x, position.y - input.speakerPosition.y, position.z - input.speakerPosition.z) <= input.hearingRadius)
    .map(({ id }) => id);
  if (recipientIds.length === 0) return null;
  const clueId = input.turn.clueId && isPublicObservableFactId(input.turn.clueId) ? input.turn.clueId : undefined;
  return {
    type: 'resident.utterance',
    eventId: input.eventId,
    tick: input.tick,
    recipientIds,
    speakerId: input.speakerId,
    topic: clueId ? VILLAGE_FACTS[clueId].topic : 'general',
    ...(clueId ? { claimedFactId: clueId } : {}),
  };
}
