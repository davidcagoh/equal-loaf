import assert from 'node:assert/strict';
import test from 'node:test';
import { createVillageCognitionState, reduceVillageObservation } from './village-cognition.ts';
import { createRoutineWorldObservation } from './village-observations.ts';

test('a public landmark observation teaches only residents within range and never verifies hearsay', () => {
  const residents = [
    { id: 'tobin', position: { x: 0, y: 64, z: 0 } },
    { id: 'mira', position: { x: 8, y: 64, z: 0 } },
    { id: 'pip', position: { x: 13, y: 64, z: 0 } },
  ];
  const event = createRoutineWorldObservation({
    stopId: 'map-board', eventId: 'map-board-tobin-1', tick: 1,
    observerPosition: { x: 0, y: 64, z: 0 }, residents, hearingRadius: 12,
  });
  assert.ok(event);
  assert.equal(event.factId, 'route-mark');
  assert.deepEqual(event.recipientIds, ['tobin', 'mira']);

  const initial = createVillageCognitionState();
  const observed = reduceVillageObservation(initial, event);
  assert.ok(observed.residents.mira.knownFactIds.includes('route-mark'));
  assert.equal(observed.residents.pip.knownFactIds.includes('route-mark'), false);
  assert.deepEqual(reduceVillageObservation(observed, event), observed);
  assert.equal(createRoutineWorldObservation({
    stopId: 'mira-sighting', eventId: 'private-clue', tick: 2,
    observerPosition: { x: 0, y: 64, z: 0 }, residents, hearingRadius: 12,
  }), null);
});

test('only authored public observation stops expose routine facts', () => {
  const common = {
    eventId: 'observation', tick: 1, observerPosition: { x: 0, y: 0, z: 0 },
    residents: [{ id: 'mira', position: { x: 0, y: 0, z: 0 } }], hearingRadius: 12,
  };
  assert.equal(createRoutineWorldObservation({ ...common, stopId: 'west-garden' })?.factId, 'seedlings-safe');
  assert.equal(createRoutineWorldObservation({ ...common, stopId: 'map-board' })?.factId, 'route-mark');
  assert.equal(createRoutineWorldObservation({ ...common, stopId: 'grain-store' }), null);
  assert.equal(createRoutineWorldObservation({ ...common, stopId: 'bakery-hearth' }), null);
});
