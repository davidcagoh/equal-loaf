import assert from 'node:assert/strict';
import test from 'node:test';
import { createVillageCognitionState, getResidentKnowledgeContext, reduceVillageObservation, selectResidentIntent, type VillageObservation } from './village-cognition.ts';
import { villageProfiles } from './village-profiles.ts';
import {
  PLAYER_RESPONSE_RADIUS,
  RESIDENT_HEARING_RADIUS,
  createNoResidentGuidance,
  getCurrentRoutineStopId,
  getRoutineStopPosition,
  getResidentsWithinHearingRadius,
  selectPttResident,
  type EncounterResident,
} from './village-encounters.ts';

const PLAYER_SPAWN = { x: 71, y: 69, z: 19 } as const;
const RANDOM_HOMES = {
  mira: { x: 86, y: 69, z: 20 },
  tobin: { x: 61, y: 70, z: 25 },
  pip: { x: 75, y: 70, z: -2 },
} as const;

function routeResidents(cycle: number): EncounterResident[] {
  return villageProfiles.map((profile, index) => {
    const home = RANDOM_HOMES[profile.id as keyof typeof RANDOM_HOMES];
    const stop = profile.routine[(index + cycle) % profile.routine.length]!;
    const position = getRoutineStopPosition(home, stop);
    return {
      residentId: profile.id,
      name: profile.username,
      position,
      locationId: getCurrentRoutineStopId(home, profile.routine, position),
    };
  });
}

function canGreet(state: ReturnType<typeof createVillageCognitionState>, candidate: EncounterResident, tick = 10_000): boolean {
  return Boolean(selectResidentIntent(state, {
    residentId: candidate.residentId,
    playerIntent: 'greet',
    topic: 'general',
    locationId: candidate.locationId,
    tick,
  }, tick >>> 0));
}

test('a resident can accept an ordinary authored greeting at any current routine stop', () => {
  const state = createVillageCognitionState();
  for (const profile of villageProfiles) {
    for (const stop of profile.routine) {
      const intent = selectResidentIntent(state, {
        residentId: profile.id,
        playerIntent: 'greet',
        topic: 'general',
        locationId: stop.id,
        tick: 10_000,
      }, 1);
      assert.ok(intent, `${profile.username} should be greetable at ${stop.id}`);
      assert.equal(intent?.speech.kind, 'authored_line');
    }
  }
});

test('an ordinary routine stop selects the resident authored greeting instead of rejecting the encounter', () => {
  const state = createVillageCognitionState();
  const profile = villageProfiles.find(({ id }) => id === 'mira');
  assert.ok(profile);
  const intent = selectResidentIntent(state, {
    residentId: profile.id,
    playerIntent: 'greet',
    topic: 'general',
    locationId: 'market-well',
    tick: 10_000,
  }, 1);
  assert.equal(intent?.speech.kind === 'authored_line' ? intent.speech.lineId : null, 'mira-routine-greeting');
  const knowledge = getResidentKnowledgeContext(state, profile.id, {
    residentId: profile.id, playerIntent: 'greet', topic: 'general', locationId: 'market-well', tick: 10_000,
  });
  assert.deepEqual(knowledge.responseOptions.map(({ lineId }) => lineId), ['mira-routine-greeting']);
  assert.equal(knowledge.factIds.includes('mira-sighting'), false);
});

test('fresh spawn and several persisted-home routine cycles remain outside 8-block PTT until the player approaches', () => {
  const state = createVillageCognitionState();
  const fresh = villageProfiles.map((profile) => ({
    residentId: profile.id,
    name: profile.username,
    position: RANDOM_HOMES[profile.id as keyof typeof RANDOM_HOMES],
    locationId: profile.routine[0]!.id,
  }));
  assert.equal(selectPttResident(PLAYER_SPAWN, fresh, (candidate) => canGreet(state, candidate)), null);

  const initialGuidance = createNoResidentGuidance(PLAYER_SPAWN, routeResidents(0), (candidate) => canGreet(state, candidate));
  for (let cycle = 0; cycle < villageProfiles[0]!.routine.length * 2; cycle += 1) {
    const residents = routeResidents(cycle);
    assert.equal(selectPttResident(PLAYER_SPAWN, residents, (candidate) => canGreet(state, candidate)), null,
      `routine cycle ${cycle} should preserve the actual 8-block response boundary`);
  }
  const laterResidents = routeResidents(4);
  const laterGuidance = createNoResidentGuidance(PLAYER_SPAWN, laterResidents, (candidate) => canGreet(state, candidate));
  assert.notEqual(laterGuidance, initialGuidance, 'guidance must follow current routine positions, not a cached spawn point');

  const target = laterResidents.reduce((nearest, candidate) => {
    const distance = Math.hypot(candidate.position.x - PLAYER_SPAWN.x, candidate.position.y - PLAYER_SPAWN.y, candidate.position.z - PLAYER_SPAWN.z);
    return distance < nearest.distance ? { candidate, distance } : nearest;
  }, { candidate: laterResidents[0]!, distance: Number.POSITIVE_INFINITY }).candidate;
  const nearbyExplorer = { x: target.position.x + PLAYER_RESPONSE_RADIUS - 0.1, y: target.position.y, z: target.position.z };
  const selected = selectPttResident(nearbyExplorer, [target], (candidate) => canGreet(state, candidate));
  assert.equal(selected?.resident.residentId, target.residentId);
  assert.ok(selected?.distance !== undefined && selected.distance < PLAYER_RESPONSE_RADIUS);

  const recededExplorer = { x: target.position.x + PLAYER_RESPONSE_RADIUS + 0.1, y: target.position.y, z: target.position.z };
  assert.equal(selectPttResident(recededExplorer, [target], (candidate) => canGreet(state, candidate)), null);
  assert.equal(selectPttResident(nearbyExplorer, [target], (candidate) => canGreet(state, candidate))?.resident.residentId, target.residentId);
});

test('nearest eligible PTT responder differs from a resident who only hears within 12 blocks', () => {
  const state = createVillageCognitionState();
  const residents: EncounterResident[] = [
    { residentId: 'mira', name: 'Anna', locationId: 'west-garden', position: { x: 7.5, y: 0, z: 0 } },
    { residentId: 'tobin', name: 'James', locationId: 'map-board', position: { x: 10, y: 0, z: 0 } },
    { residentId: 'pip', name: 'Thomas', locationId: 'bakery-hearth', position: { x: 12.1, y: 0, z: 0 } },
  ];
  const selected = selectPttResident({ x: 0, y: 0, z: 0 }, residents, (candidate) => canGreet(state, candidate));
  assert.equal(selected?.resident.residentId, 'mira');
  assert.equal(selected?.distance, 7.5);
  assert.equal(PLAYER_RESPONSE_RADIUS, 8);
  assert.equal(RESIDENT_HEARING_RADIUS, 12);

  const recipientIds = getResidentsWithinHearingRadius({ x: 0, y: 0, z: 0 }, residents);
  assert.deepEqual(recipientIds, ['mira', 'tobin']);
  const observation: VillageObservation = {
    type: 'player.intent', eventId: 'encounter-hearing-check', tick: 10_001,
    recipientIds, intent: 'greet', topic: 'general',
  };
  const heard = reduceVillageObservation(state, observation);
  assert.equal(heard.residents.mira?.heardClaims.length, 1);
  assert.equal(heard.residents.tobin?.heardClaims.length, 1);
  assert.equal(heard.residents.pip?.heardClaims.length, 0);
  assert.equal(selectPttResident({ x: 0, y: 0, z: 0 }, residents, (candidate) => canGreet(heard, candidate))?.resident.residentId, 'mira');
  assert.ok(Math.hypot(10, 0, 0) <= RESIDENT_HEARING_RADIUS && Math.hypot(10, 0, 0) > PLAYER_RESPONSE_RADIUS);
});
