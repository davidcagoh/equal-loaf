import type { RoutineStop } from './village-profiles.ts';

export const PLAYER_RESPONSE_RADIUS = 8;
export const RESIDENT_HEARING_RADIUS = 12;

export interface Position3D {
  x: number;
  y: number;
  z: number;
}

export interface EncounterResident {
  residentId: string;
  name: string;
  position: Position3D;
  locationId: string;
}

export interface PttResidentSelection {
  resident: EncounterResident;
  distance: number;
}

export function getRoutineStopPosition(home: Position3D, stop: RoutineStop): Position3D {
  const [offsetX, offsetZ] = stop.offset;
  return { x: home.x + offsetX, y: home.y, z: home.z + offsetZ };
}

export function getCurrentRoutineStopId(
  home: Position3D,
  routine: readonly RoutineStop[],
  position: Position3D,
): string | undefined {
  return [...routine]
    .map((stop) => ({
      id: stop.id,
      distance: distance3D(position, getRoutineStopPosition(home, stop)),
    }))
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))[0]?.id;
}

export function distance3D(left: Position3D, right: Position3D): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function selectPttResident(
  explorer: Position3D,
  residents: readonly EncounterResident[],
  isEligible: (resident: EncounterResident) => boolean,
): PttResidentSelection | null {
  return rankedResidents(explorer, residents)
    .find(({ resident, distance }) => distance <= PLAYER_RESPONSE_RADIUS && isEligible(resident)) ?? null;
}

export function getResidentsWithinHearingRadius(
  explorer: Position3D,
  residents: readonly EncounterResident[],
): string[] {
  return rankedResidents(explorer, residents)
    .filter(({ distance }) => distance <= RESIDENT_HEARING_RADIUS)
    .map(({ resident }) => resident.residentId);
}

export function createNoResidentGuidance(
  explorer: Position3D,
  residents: readonly EncounterResident[],
  isEligible: (resident: EncounterResident) => boolean,
): string {
  const ranked = rankedResidents(explorer, residents);
  const nearestEligible = ranked.find(({ resident }) => isEligible(resident));
  const target = nearestEligible ?? ranked[0];
  if (!target) return 'No resident is available yet. Wait for the village to load, then approach a resident within 8 blocks.';
  if (target.distance <= PLAYER_RESPONSE_RADIUS) {
    return 'A resident is close enough, but cannot answer right now. Wait briefly or approach another villager, then try again.';
  }

  const direction = compassDirection(explorer, target.resident.position);
  const route = direction ? ` ${direction}` : '';
  return `No resident can answer within 8 blocks. Walk about ${Math.ceil(target.distance)} blocks${route} toward ${target.resident.name}, then try again within 8 blocks.`;
}

function rankedResidents(
  explorer: Position3D,
  residents: readonly EncounterResident[],
): PttResidentSelection[] {
  return residents
    .map((resident) => ({ resident, distance: distance3D(explorer, resident.position) }))
    .sort((left, right) => left.distance - right.distance || left.resident.residentId.localeCompare(right.resident.residentId));
}

function compassDirection(from: Position3D, to: Position3D): string | undefined {
  if (Math.hypot(to.x - from.x, to.z - from.z) < 0.5) return undefined;
  const degrees = (Math.atan2(to.x - from.x, from.z - to.z) * 180 / Math.PI + 360) % 360;
  const directions = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return directions[Math.round(degrees / 45) % directions.length];
}
