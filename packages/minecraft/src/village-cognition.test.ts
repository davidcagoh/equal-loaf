import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVillageCognitionState,
  authoredLine,
  getResidentKnowledgeContext,
  latestHeardClaimEventId,
  latestHeardPlayerIntentEventId,
  reduceVillageObservation,
  resolvePttResidentIntent,
  selectResidentIntent,
  validateResidentIntent,
  validateSemanticResponse,
  type VillageObservation,
} from './village-cognition.ts';

function playerIntent(eventId: string, recipientIds: readonly string[], topic: 'garden' | 'bell' | 'flour' | 'route' | 'general' = 'garden'): VillageObservation {
  return { type: 'player.intent', eventId, tick: 1, recipientIds, intent: 'ask_about_known_topic', topic };
}

test('only in-earshot residents independently record an attributed player claim', () => {
  const initial = createVillageCognitionState();
  const after = reduceVillageObservation(initial, playerIntent('turn-1', ['mira', 'tobin']));

  assert.equal(after.residents.mira?.heardClaims.length, 1);
  assert.equal(after.residents.tobin?.heardClaims.length, 1);
  assert.equal(after.residents.pip?.heardClaims.length, 0);
  assert.deepEqual(after.residents.mira?.knownFactIds, initial.residents.mira?.knownFactIds);
  assert.equal(after.residents.mira?.heardClaims[0]?.sourceId, 'player');
  assert.equal(after.residents.tobin?.heardClaims[0]?.eventId, 'turn-1');
});

test('duplicate observation events are idempotent across all recipients', () => {
  const initial = createVillageCognitionState();
  const observation = playerIntent('turn-duplicate', ['mira', 'pip']);
  const once = reduceVillageObservation(initial, observation);
  const twice = reduceVillageObservation(once, observation);

  assert.equal(twice.residents.mira?.heardClaims.length, 1);
  assert.equal(twice.residents.pip?.heardClaims.length, 1);
  assert.equal(twice.residents.tobin?.heardClaims.length, 0);
});

test('an in-range resident attributes a public claim and later selects its authored reply without verifying it', () => {
  const initial = createVillageCognitionState();
  const context = {
    residentId: 'pip', playerIntent: 'greet' as const, topic: 'general' as const,
    locationId: 'bakery-hearth', tick: 10,
  };
  const before = selectResidentIntent(initial, context, 11);
  assert.equal(before?.beatId, 'pip-guarded-bakery-reply');

  const publicUtterance: VillageObservation = {
    type: 'resident.utterance', eventId: 'tobin-route-1', tick: 1,
    recipientIds: ['pip'], speakerId: 'tobin', topic: 'route', claimedFactId: 'route-mark',
  };
  const heard = reduceVillageObservation(initial, publicUtterance);
  assert.equal(heard.residents.pip?.heardClaims[0]?.sourceId, 'tobin');
  assert.equal(heard.residents.pip?.heardClaims[0]?.claimedFactId, 'route-mark');
  assert.deepEqual(heard.residents.pip?.knownFactIds, initial.residents.pip?.knownFactIds);
  assert.equal(heard.residents.pip?.knownFactIds.includes('route-mark'), false);
  assert.equal(heard.residents.mira?.heardClaims.length, 0);
  assert.equal(latestHeardClaimEventId(heard, 'pip', 'tobin', 'route-mark'), 'tobin-route-1');
  assert.equal(latestHeardClaimEventId(heard, 'mira', 'tobin', 'route-mark'), undefined);

  const heardClaimEventId = latestHeardClaimEventId(heard, 'pip', 'tobin', 'route-mark');
  const intent = selectResidentIntent(heard, { ...context, heardClaimEventId }, 11);
  assert.equal(intent?.beatId, 'pip-heard-route-from-tobin');
  assert.notDeepEqual(intent?.action, before?.action);
  assert.deepEqual(intent?.action, { kind: 'look_at_player' });
  assert.deepEqual(intent?.speech, { kind: 'authored_line', lineId: 'pip-heard-route-from-tobin' });
  assert.equal(authoredLine(intent?.speech.lineId ?? ''), 'Tobin marked a flour cart path on his map. I heard him say it, but I have not checked that route myself.');

  const responseContext = getResidentKnowledgeContext(heard, 'pip', { ...context, heardClaimEventId: 'tobin-route-1' });
  assert.ok(responseContext.responseOptions.some(({ lineId }) => lineId === 'pip-heard-route-from-tobin'));
  const response = validateSemanticResponse({
    playerIntent: 'greet', topic: 'general', lineId: 'pip-heard-route-from-tobin',
  }, { residentId: 'pip', context: responseContext });
  assert.ok(response);
  const modelSelected = selectResidentIntent(heard, { ...context, heardClaimEventId: 'tobin-route-1' }, 11, response);
  assert.equal(modelSelected?.beatId, 'pip-heard-route-from-tobin');
  assert.deepEqual(modelSelected?.action, { kind: 'look_at_player' });
  assert.equal(getResidentKnowledgeContext(heard, 'pip', { ...context, heardClaimEventId: 'missing-event' }).responseOptions
    .some(({ lineId }) => lineId === 'pip-heard-route-from-tobin'), false);
  assert.equal(getResidentKnowledgeContext(heard, 'pip', { ...context, locationId: 'market-well' }).responseOptions
    .some(({ lineId }) => lineId === 'pip-heard-route-from-tobin'), false);
});

test('repeated public claims remain attributed hearsay and private or unauthored claims are rejected', () => {
  const initial = createVillageCognitionState();
  const first = reduceVillageObservation(initial, {
    type: 'resident.utterance', eventId: 'route-claim-1', tick: 1,
    recipientIds: ['pip'], speakerId: 'tobin', topic: 'route', claimedFactId: 'route-mark',
  });
  const repeated = reduceVillageObservation(first, {
    type: 'resident.utterance', eventId: 'route-claim-2', tick: 2,
    recipientIds: ['pip'], speakerId: 'tobin', topic: 'route', claimedFactId: 'route-mark',
  });
  const forged = reduceVillageObservation(repeated, {
    type: 'resident.utterance', eventId: 'private-claim', tick: 3,
    recipientIds: ['pip'], speakerId: 'mira', topic: 'garden', claimedFactId: 'mira-sighting',
  });
  const unauthoredSource = reduceVillageObservation(forged, {
    type: 'resident.utterance', eventId: 'unsupported-route-claim', tick: 4,
    recipientIds: ['pip'], speakerId: 'mira', topic: 'route', claimedFactId: 'route-mark',
  });

  assert.equal(unauthoredSource.residents.pip?.heardClaims.length, 2);
  assert.equal(unauthoredSource.residents.pip?.knownFactIds.includes('route-mark'), false);
  assert.equal(unauthoredSource.residents.pip?.knownFactIds.includes('mira-sighting'), false);
  assert.equal(unauthoredSource.residents.pip?.heardClaims.some(({ eventId }) => eventId === 'private-claim'), false);
  assert.equal(unauthoredSource.residents.pip?.heardClaims.some(({ eventId }) => eventId === 'unsupported-route-claim'), false);
  assert.equal(selectResidentIntent(unauthoredSource, {
    residentId: 'pip', playerIntent: 'ask_about_known_topic', topic: 'flour', locationId: 'bakery-hearth',
    tick: 10, heardClaimEventId: 'private-claim',
  }, 11), null);
});

test('a nearby trusted resident later reacts to the player’s recent garden-help request', () => {
  let state = createVillageCognitionState();
  state = reduceVillageObservation(state, {
    type: 'player.behavior', eventId: 'mira-trust-1', tick: 1,
    recipientIds: ['mira'], behavior: 'respectful_exchange',
  });
  const context = {
    residentId: 'mira', playerIntent: 'greet' as const, topic: 'general' as const,
    locationId: 'west-garden', tick: 30_000,
  };
  const ordinary = selectResidentIntent(state, context, 20);
  assert.equal(ordinary?.beatId, 'mira-guarded-garden-reply');

  const request: VillageObservation = {
    type: 'player.intent', eventId: 'player-garden-help-1', tick: 20_000,
    recipientIds: ['mira', 'tobin'], intent: 'ask_for_help', topic: 'garden',
  };
  state = reduceVillageObservation(state, request);
  state = reduceVillageObservation(state, request);
  assert.equal(state.residents.mira?.heardClaims.length, 1);
  state = reduceVillageObservation(state, { ...request, eventId: 'player-garden-help-2', tick: 21_000 });
  assert.equal(state.residents.mira?.heardClaims.length, 2);
  assert.equal(state.residents.mira?.trust, 1);
  assert.equal(state.residents.pip?.heardClaims.length, 0);
  assert.equal(state.residents.mira?.knownFactIds.includes('mira-sighting'), true);
  const heardEventId = latestHeardPlayerIntentEventId(state, 'mira', 'ask_for_help', 'garden', 30_000);
  assert.equal(heardEventId, 'player-garden-help-2');
  assert.equal(latestHeardPlayerIntentEventId(state, 'pip', 'ask_for_help', 'garden', 30_000), undefined);

  const response = selectResidentIntent(state, {
    ...context,
    heardPlayerIntentEventId: heardEventId,
  }, 20);
  assert.ok(response);
  assert.equal(response?.beatId, 'mira-heard-garden-help');
  assert.deepEqual(response?.action, { kind: 'idle' });
  assert.deepEqual(response?.speech, { kind: 'authored_line', lineId: 'mira-heard-garden-help' });
  assert.equal(authoredLine(response?.speech.lineId ?? ''), 'You asked about helping in the garden earlier. I could use another pair of hands checking the seedlings.');
  assert.deepEqual(response?.allowedFactIds, ['silent-bell', 'seedlings-safe']);
  assert.equal(validateResidentIntent(state, response, { ...context, heardPlayerIntentEventId: heardEventId }), true);
  assert.equal(selectResidentIntent(state, context, 20)?.beatId, 'mira-heard-garden-help');
  const pipContext = { residentId: 'pip', playerIntent: 'greet' as const, topic: 'general' as const, locationId: 'bakery-hearth', tick: 30_000 };
  assert.equal(selectResidentIntent(state, pipContext, 20)?.beatId, 'pip-guarded-bakery-reply');
  const resolved = resolvePttResidentIntent(state, {
    residentId: 'mira', locationId: 'west-garden', tick: context.tick, heardPlayerIntentEventId: heardEventId,
  }, 20, { playerIntent: 'greet', topic: 'general', lineId: 'mira-guarded-garden-reply' });
  assert.equal(resolved?.intent.beatId, 'mira-heard-garden-help');

  const completed = reduceVillageObservation(state, {
    type: 'beat.completed', eventId: 'mira-garden-help-done', tick: context.tick,
    residentId: 'mira', beatId: 'mira-heard-garden-help',
  });
  const repeatedRequest = reduceVillageObservation(completed, {
    ...request, eventId: 'player-garden-help-3', tick: context.tick + 1,
  });
  assert.equal(selectResidentIntent(repeatedRequest, { ...context, tick: context.tick + 10_000 }, 20)?.beatId, 'mira-guarded-garden-reply');
});

test('player-intent memory must be recent, recipient-owned, and relationship-eligible', () => {
  const initial = createVillageCognitionState();
  const asked = reduceVillageObservation(initial, {
    type: 'player.intent', eventId: 'old-garden-help', tick: 10,
    recipientIds: ['mira'], intent: 'ask_for_help', topic: 'garden',
  });
  const scene = {
    residentId: 'mira', playerIntent: 'greet' as const, topic: 'general' as const,
    locationId: 'west-garden', tick: 120_011,
  };
  assert.equal(latestHeardPlayerIntentEventId(asked, 'mira', 'ask_for_help', 'garden', scene.tick), undefined);
  assert.equal(selectResidentIntent(asked, { ...scene, heardPlayerIntentEventId: 'old-garden-help' }, 21)?.beatId, 'mira-guarded-garden-reply');

  const fresh = reduceVillageObservation(createVillageCognitionState(), {
    type: 'player.intent', eventId: 'fresh-garden-help', tick: 100_000,
    recipientIds: ['mira'], intent: 'ask_for_help', topic: 'garden',
  });
  assert.equal(latestHeardPlayerIntentEventId(fresh, 'mira', 'ask_for_help', 'garden', 120_000), 'fresh-garden-help');
  assert.equal(selectResidentIntent(fresh, {
    ...scene, tick: 120_000, heardPlayerIntentEventId: 'fresh-garden-help',
  }, 21)?.beatId, 'mira-guarded-garden-reply');
  assert.equal(latestHeardPlayerIntentEventId(fresh, 'mira', 'ask_for_help', 'flour', 120_000), undefined);
  assert.equal(latestHeardPlayerIntentEventId(fresh, 'pip', 'ask_for_help', 'garden', 120_000), undefined);

  const trusted = reduceVillageObservation(fresh, {
    type: 'player.behavior', eventId: 'mira-trust-2', tick: 100_001,
    recipientIds: ['mira'], behavior: 'respectful_exchange',
  });
  assert.equal(selectResidentIntent(trusted, {
    ...scene, tick: 120_000, heardPlayerIntentEventId: 'fresh-garden-help',
  }, 21)?.beatId, 'mira-heard-garden-help');
  assert.equal(selectResidentIntent(trusted, {
    ...scene, tick: 120_000, heardPlayerIntentEventId: 'unrelated-event',
  }, 21)?.beatId, 'mira-guarded-garden-reply');
});

test('only public observable facts can become verified knowledge through direct observation', () => {
  const initial = createVillageCognitionState();
  const sawWork = reduceVillageObservation(initial, { type: 'world.fact_observed', eventId: 'saw-seedlings', tick: 1, recipientIds: ['tobin'], factId: 'seedlings-safe' });
  const overheardSighting = reduceVillageObservation(sawWork, { type: 'world.fact_observed', eventId: 'invent-sighting', tick: 2, recipientIds: ['tobin'], factId: 'mira-sighting' });

  assert.equal(sawWork.residents.tobin?.knownFactIds.includes('seedlings-safe'), true);
  assert.equal(overheardSighting.residents.tobin?.knownFactIds.includes('mira-sighting'), false);
});

test('Mira can disclose her private sighting only at the garden after trust prerequisite', () => {
  const state = createVillageCognitionState();
  const tooSoon = selectResidentIntent(state, { residentId: 'mira', playerIntent: 'ask_about_known_topic', topic: 'garden', locationId: 'west-garden', tick: 1 }, 17);
  assert.notEqual(tooSoon?.beatId, 'mira-disclose-sighting');

  const trusted = reduceVillageObservation(state, { type: 'player.behavior', eventId: 'visit-1', tick: 2, recipientIds: ['mira'], behavior: 'respectful_exchange' });
  const ready = reduceVillageObservation(trusted, { type: 'player.behavior', eventId: 'visit-2', tick: 3, recipientIds: ['mira'], behavior: 'respectful_exchange' });
  const eligible = selectResidentIntent(ready, { residentId: 'mira', playerIntent: 'ask_about_known_topic', topic: 'garden', locationId: 'west-garden', tick: 4 }, 17);

  assert.equal(eligible?.beatId, 'mira-disclose-sighting');
  assert.deepEqual(eligible?.action, { kind: 'continue_routine', waypointId: 'west-garden' });
  assert.deepEqual(eligible?.speech, { kind: 'authored_line', lineId: 'mira-sighting-disclosure' });
  assert.equal(eligible?.allowedFactIds.includes('mira-sighting'), true);
  const disclosureContext = getResidentKnowledgeContext(ready, 'mira', { residentId: 'mira', playerIntent: 'ask_about_known_topic', topic: 'garden', locationId: 'west-garden', tick: 4 });
  const generated = validateSemanticResponse({ playerIntent: 'ask_about_known_topic', topic: 'garden', lineId: 'mira-guarded-garden-reply' }, { residentId: 'mira', context: disclosureContext });
  assert.ok(generated);
  const disclosure = selectResidentIntent(ready, { residentId: 'mira', playerIntent: 'ask_about_known_topic', topic: 'garden', locationId: 'west-garden', tick: 4 }, 17, generated);
  assert.deepEqual(disclosure?.speech, { kind: 'authored_line', lineId: 'mira-sighting-disclosure' });
  assert.ok(eligible);
  assert.equal(validateResidentIntent(ready, eligible, { residentId: 'mira', playerIntent: 'ask_about_known_topic', topic: 'garden', locationId: 'west-garden', tick: eligible.expiresAtTick }), true);
  assert.equal(validateResidentIntent(ready, eligible, { residentId: 'mira', playerIntent: 'ask_about_known_topic', topic: 'garden', locationId: 'west-garden', tick: eligible.expiresAtTick + 1 }), false);
  assert.equal(validateResidentIntent(ready, eligible, { residentId: 'mira', playerIntent: 'ask_about_known_topic', topic: 'garden', locationId: 'market-well', tick: 5 }), false);
});

test('PTT validates a safe public garden choice then resolves Mira’s reveal locally', () => {
  const state = createVillageCognitionState();
  const safeContext = getResidentKnowledgeContext(state, 'mira');
  assert.equal(safeContext.factIds.includes('mira-sighting'), false);
  assert.equal(safeContext.responseOptions.some(({ lineId }) => lineId === 'mira-sighting-disclosure'), false);
  const response = validateSemanticResponse({
    playerIntent: 'ask_about_known_topic', topic: 'garden', lineId: 'mira-guarded-garden-reply',
  }, { residentId: 'mira', context: safeContext });
  assert.ok(response);

  const scene = { residentId: 'mira', locationId: 'west-garden', tick: 10 };
  const untrusted = resolvePttResidentIntent(state, scene, 17, response);
  assert.equal(untrusted?.context.playerIntent, 'ask_about_known_topic');
  assert.equal(untrusted?.intent.speech.kind === 'authored_line' && untrusted.intent.speech.lineId, 'mira-guarded-garden-reply');

  const trusted = reduceVillageObservation(
    reduceVillageObservation(state, { type: 'player.behavior', eventId: 'ptt-trust-1', tick: 1, recipientIds: ['mira'], behavior: 'respectful_exchange' }),
    { type: 'player.behavior', eventId: 'ptt-trust-2', tick: 2, recipientIds: ['mira'], behavior: 'respectful_exchange' },
  );
  const eligible = resolvePttResidentIntent(trusted, { ...scene, tick: 3 }, 17, response);
  assert.equal(eligible?.intent.beatId, 'mira-disclose-sighting');
  assert.equal(eligible?.intent.speech.kind === 'authored_line' && eligible.intent.speech.lineId, 'mira-sighting-disclosure');
  assert.equal(eligible?.intent.allowedFactIds.includes('mira-sighting'), true);
  assert.equal(resolvePttResidentIntent(trusted, { ...scene, locationId: 'market-well', tick: 3 }, 17, response), null);
  assert.equal(resolvePttResidentIntent(trusted, scene, 17, {
    playerIntent: 'ask_about_known_topic', topic: 'garden', lineId: 'mira-sighting-disclosure',
  }), null);
});

test('beat choice is repeatable and expiry/cooldown prevents immediate replay', () => {
  const state = createVillageCognitionState();
  const context = { residentId: 'mira', playerIntent: 'greet' as const, topic: 'general' as const, locationId: 'west-garden', tick: 1 };
  const first = selectResidentIntent(state, context, 42);
  const repeat = selectResidentIntent(state, context, 42);

  assert.deepEqual(first, repeat);
  assert.ok(first);
  const after = reduceVillageObservation(state, { type: 'beat.completed', eventId: 'beat-1', tick: 1, residentId: 'mira', beatId: first.beatId });
  assert.notEqual(selectResidentIntent(after, context, 42)?.beatId, first.beatId);
  assert.equal(selectResidentIntent(after, { ...context, tick: 1 + 60_000 }, 42)?.beatId, first.beatId);

  const tieContext = { ...context, playerIntent: 'ask_for_help' as const, topic: 'garden' as const };
  const seedOne = selectResidentIntent(state, tieContext, 1);
  const seedTwo = selectResidentIntent(state, tieContext, 2);
  assert.equal(seedOne?.beatId, selectResidentIntent(state, tieContext, 1)?.beatId);
  assert.notEqual(seedOne?.beatId, seedTwo?.beatId);
});

test('resident context contains only that resident’s allowed facts and excludes story solution', () => {
  const state = createVillageCognitionState();
  const context = getResidentKnowledgeContext(state, 'mira');
  assert.deepEqual(context.factIds, ['silent-bell', 'seedlings-safe']);
  assert.equal(JSON.stringify(context).toLowerCase().includes('pip-killed-rowan'), false);
  assert.equal(JSON.stringify(context).toLowerCase().includes('culprit'), false);
  assert.ok(context.responseOptions.some(({ lineId }) => lineId === 'mira-guarded-garden-reply'));
  assert.equal(context.responseOptions.some(({ lineId }) => lineId === 'mira-sighting-disclosure'), false);
  const guarded = selectResidentIntent(createVillageCognitionState(), { residentId: 'mira', playerIntent: 'greet', topic: 'general', locationId: 'west-garden', tick: 1 }, 8);
  assert.equal(guarded?.allowedFactIds.includes('mira-sighting'), false);
  assert.ok(guarded);
  const contaminated = { ...guarded, allowedFactIds: [...guarded.allowedFactIds, 'mira-sighting'] };
  assert.equal(validateResidentIntent(state, contaminated, { residentId: 'mira', playerIntent: 'greet', topic: 'general', locationId: 'west-garden', tick: 1 }), false);
});

test('Mira’s private sighting enters model context only after trust and place prerequisites', () => {
  let state = createVillageCognitionState();
  state = reduceVillageObservation(state, { type: 'player.behavior', eventId: 'trust-1', tick: 1, recipientIds: ['mira'], behavior: 'respectful_exchange' });
  state = reduceVillageObservation(state, { type: 'player.behavior', eventId: 'trust-2', tick: 2, recipientIds: ['mira'], behavior: 'respectful_exchange' });
  const outsideGarden = getResidentKnowledgeContext(state, 'mira', { residentId: 'mira', playerIntent: 'ask_about_known_topic', topic: 'garden', locationId: 'market-well', tick: 3 });
  const inGarden = getResidentKnowledgeContext(state, 'mira', { residentId: 'mira', playerIntent: 'ask_about_known_topic', topic: 'garden', locationId: 'west-garden', tick: 3 });

  assert.equal(outsideGarden.factIds.includes('mira-sighting'), false);
  assert.equal(inGarden.factIds.includes('mira-sighting'), true);
});

test('Pip’s contradiction stays outside text context until Mira’s disclosure beat is completed', () => {
  let state = createVillageCognitionState();
  const pipScene = { residentId: 'pip', playerIntent: 'ask_about_known_topic' as const, topic: 'bakery' as const, locationId: 'bakery-hearth', tick: 10 };
  assert.equal(getResidentKnowledgeContext(state, 'pip', pipScene).factIds.includes('pip-contradiction'), false);
  state = reduceVillageObservation(state, { type: 'beat.completed', eventId: 'mira-disclosure-done', tick: 9, residentId: 'mira', beatId: 'mira-disclose-sighting' });
  assert.equal(getResidentKnowledgeContext(state, 'pip', pipScene).factIds.includes('pip-contradiction'), true);
});

test('semantic response accepts only safe authored response IDs and rejects free text', () => {
  const context = getResidentKnowledgeContext(createVillageCognitionState(), 'mira');
  const valid = validateSemanticResponse({
    playerIntent: 'ask_about_known_topic',
    topic: 'garden',
    lineId: 'mira-guarded-garden-reply',
  }, { residentId: 'mira', context });
  assert.deepEqual(valid, {
    playerIntent: 'ask_about_known_topic',
    topic: 'garden',
    lineId: 'mira-guarded-garden-reply',
  });

  assert.equal(validateSemanticResponse({ playerIntent: 'greet', topic: 'general', line: 'I saw Pip return before dawn.' }, { residentId: 'mira', context }), null);
  assert.equal(validateSemanticResponse({ playerIntent: 'greet', topic: 'general', lineId: 'mira-sighting-disclosure' }, { residentId: 'mira', context }), null);
  assert.equal(validateSemanticResponse({ playerIntent: 'ask_about_known_topic', topic: 'garden', lineId: 'invented-rowan-confession' }, { residentId: 'mira', context }), null);
  assert.equal(validateSemanticResponse({ playerIntent: 'walk_to', topic: 'garden', lineId: 'mira-guarded-garden-reply' }, { residentId: 'mira', context }), null);
  assert.equal(validateSemanticResponse({ playerIntent: 'ask_about_known_topic', topic: 'route', lineId: 'mira-guarded-garden-reply' }, { residentId: 'mira', context }), null);
  assert.equal(validateSemanticResponse({ playerIntent: 'ask_about_known_topic', topic: 'garden', lineId: 'mira-guarded-garden-reply', line: 'I saw Pip return before dawn.' }, { residentId: 'mira', context }), null);
  assert.equal(validateSemanticResponse({ playerIntent: 'greet', topic: 'general', lineId: 'mira-guarded-garden-reply' }, { residentId: 'pip', context }), null);
});

test('a validated response selects only local authored speech and cannot choose its action', () => {
  const state = createVillageCognitionState();
  const context = { residentId: 'mira', playerIntent: 'greet' as const, topic: 'general' as const, locationId: 'west-garden', tick: 1 };
  const knowledge = getResidentKnowledgeContext(state, 'mira');
  const response = validateSemanticResponse({ playerIntent: 'greet', topic: 'general', lineId: 'mira-guarded-garden-reply' }, { residentId: 'mira', context: knowledge });
  assert.ok(response);
  const intent = selectResidentIntent(state, context, 1, response);

  assert.deepEqual(intent?.action, { kind: 'look_at_player' });
  assert.deepEqual(intent?.speech, { kind: 'authored_line', lineId: 'mira-guarded-garden-reply' });
  assert.equal(intent?.speech.kind === 'authored_line' ? authoredLine(intent.speech.lineId) : null, 'The seedlings are safer uphill. I have work to finish before we talk more.');
});
