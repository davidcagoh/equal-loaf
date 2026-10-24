import assert from 'node:assert/strict';
import test from 'node:test';
import { createVillageCognitionState, latestHeardClaimEventId, reduceVillageObservation, selectResidentIntent } from './village-cognition.ts';
import { createAmbientUtteranceObservation, nextResidentDialogueTurn, type ResidentDialogueCursor } from './village-dialogue-scheduler.ts';
import { villageDialogue, villageMysteryDialogue } from './village-profiles.ts';

test('resident schedules advance independently and exclude private mystery beats', () => {
  const allTurns = [...villageMysteryDialogue, ...villageDialogue];
  let miraCursor: ResidentDialogueCursor = { nextIndex: 0 };
  let pipCursor: ResidentDialogueCursor = { nextIndex: 0 };
  const miraTurn = nextResidentDialogueTurn('mira', allTurns, miraCursor);
  const pipTurn = nextResidentDialogueTurn('pip', allTurns, pipCursor);
  assert.equal(miraTurn?.turn.speakerId, 'mira');
  assert.equal(pipTurn?.turn.speakerId, 'pip');

  miraCursor = miraTurn!.cursor;
  const nextMiraTurn = nextResidentDialogueTurn('mira', allTurns, miraCursor);
  assert.equal(nextMiraTurn?.turn.speakerId, 'mira');
  assert.deepEqual(pipCursor, { nextIndex: 0 });

  const miraTurns = Array.from({ length: 8 }, (_, index) => nextResidentDialogueTurn('mira', allTurns, { nextIndex: index }))
    .flatMap((scheduled) => scheduled ? [scheduled.turn] : []);
  assert.ok(miraTurns.some(({ clueId }) => clueId === 'silent-bell'));
  assert.deepEqual([...new Set(miraTurns.flatMap(({ clueId }) => clueId ? [clueId] : []))], ['silent-bell']);

  const tobinFirst = nextResidentDialogueTurn('tobin', allTurns, { nextIndex: 0 });
  const tobinSecond = nextResidentDialogueTurn('tobin', allTurns, tobinFirst!.cursor);
  assert.equal(tobinFirst?.turn.clueId, 'flour-ledger');
  assert.equal(tobinSecond?.turn.clueId, 'route-mark');
});

test('a public route claim reaches only in-radius residents and grounds Pip’s attributed response', () => {
  const routeTurn = villageMysteryDialogue.find(({ clueId }) => clueId === 'route-mark');
  assert.ok(routeTurn);
  const observation = createAmbientUtteranceObservation({
    eventId: 'ambient-route-1', tick: 100, speakerId: 'tobin', turn: routeTurn,
    speakerPosition: { x: 0, y: 64, z: 0 }, hearingRadius: 12,
    residents: [
      { id: 'tobin', position: { x: 0, y: 64, z: 0 } },
      { id: 'pip', position: { x: 4, y: 64, z: 0 } },
      { id: 'mira', position: { x: 30, y: 64, z: 0 } },
    ],
  });
  assert.ok(observation);
  assert.deepEqual(observation.recipientIds, ['pip']);
  const state = reduceVillageObservation(createVillageCognitionState(), observation);
  const claimEventId = latestHeardClaimEventId(state, 'pip', 'tobin', 'route-mark');
  assert.equal(claimEventId, 'ambient-route-1');
  assert.equal(latestHeardClaimEventId(state, 'mira', 'tobin', 'route-mark'), undefined);
  const intent = selectResidentIntent(state, {
    residentId: 'pip', playerIntent: 'greet', topic: 'general', locationId: 'bakery-hearth', tick: 101,
    heardClaimEventId: claimEventId,
  }, 9);
  assert.equal(intent?.beatId, 'pip-heard-route-from-tobin');
  assert.equal(state.residents.pip?.knownFactIds.includes('route-mark'), false);
});

