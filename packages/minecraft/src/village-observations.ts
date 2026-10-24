import type { VillageObservation } from './village-cognition.ts';

const ROUTINE_FACTS = Object.freeze({
  'west-garden': 'seedlings-safe',
  'map-board': 'route-mark',
} as const);

interface PositionedResident {
  id: string;
  position: { x: number; y: number; z: number };
}

interface RoutineObservationInput {
  stopId: string;
  eventId: string;
  tick: number;
  observerPosition: { x: number; y: number; z: number };
  residents: readonly PositionedResident[];
  hearingRadius: number;
}

export function createRoutineWorldObservation(input: RoutineObservationInput): Extract<VillageObservation, { type: 'world.fact_observed' }> | null {
  const factId = ROUTINE_FACTS[input.stopId as keyof typeof ROUTINE_FACTS];
  if (!factId || !input.eventId || !Number.isSafeInteger(input.tick)
    || !Number.isFinite(input.hearingRadius) || input.hearingRadius <= 0
    || !validPosition(input.observerPosition)) return null;

  const recipientIds = [...new Set(input.residents
    .filter(({ id, position }) => typeof id === 'string' && id.length > 0 && validPosition(position)
      && Math.hypot(
        input.observerPosition.x - position.x,
        input.observerPosition.y - position.y,
        input.observerPosition.z - position.z,
      ) <= input.hearingRadius)
    .map(({ id }) => id))];
  if (recipientIds.length === 0) return null;
  return { type: 'world.fact_observed', eventId: input.eventId, tick: input.tick, recipientIds, factId };
}

function validPosition(position: { x: number; y: number; z: number }): boolean {
  return Boolean(position && [position.x, position.y, position.z].every(Number.isFinite));
}
