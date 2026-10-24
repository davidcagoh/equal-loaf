import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeResidentReactionCoordinator } from './village-native-reaction-coordinator.ts';

function createCoordinator(now: () => number, residents = ['mira', 'tobin', 'pip']) {
  const candidates: Array<Record<string, unknown>> = [];
  const perceived: Array<Record<string, unknown>> = [];
  let sampleTick = now();
  const coordinator = new NativeResidentReactionCoordinator({
    now,
    emitCandidate: (candidate) => candidates.push(candidate),
    rememberHeardSpeech: (event) => perceived.push(event),
    residentName: (residentId) => residentId.toUpperCase(),
    samplePlayback: (speakerId) => ({
      tick: ++sampleTick,
      speakerPosition: { x: 0, y: 0, z: 0 },
      residents: residents.map((residentId) => ({
        residentId,
        position: { x: residentId === speakerId ? 0 : 2, y: 0, z: 0 },
      })),
    }),
  });
  return { coordinator, candidates, perceived };
}

test('routine entry and fresh heard events dispatch through the production coordinator', () => {
  let now = 1_000;
  const { coordinator, candidates } = createCoordinator(() => now);
  coordinator.routineEntered({
    eventId: 'routine_mira_garden', residentId: 'mira', activity: 'watering the garden',
    motivation: 'keep seedlings healthy', at: now,
  });
  assert.equal(candidates[0]?.type, 'village.native.reaction');
  assert.equal(candidates[0]?.residentId, 'mira');
  assert.match(String(candidates[0]?.context), /watering the garden/);

  const ack = coordinator.handle({
    version: 1, type: 'ptt.reaction.ack', eventId: 'routine_mira_garden', residentId: 'mira', status: 'unavailable', at: now,
  });
  assert.equal(ack.status, 'unavailable');
  assert.equal('reactionId' in ack, false, 'pre-dispatch failure has no server reaction mapping');
  assert.equal(coordinator.activeCount, 0);

  now += 1;
  coordinator.heardSpeech({
    eventId: 'player-speech:utterance_1', speakerId: 'player', text: 'The bridge looks busy.',
    recipientIds: ['mira', 'tobin'], completedAtTick: now,
  }, { speakerName: 'the player', origin: 'player' });
  assert.deepEqual(candidates.slice(1).map(({ residentId }) => residentId), ['mira', 'tobin']);
  assert.ok(candidates.slice(1).every(({ origin }) => origin === 'player'));
});

test('resident busy state waits for PTT to finish before dispatching queued reactions', () => {
  let now = 2_000;
  const { coordinator, candidates } = createCoordinator(() => now);
  coordinator.setResidentBusy('mira', true);
  coordinator.routineEntered({ eventId: 'routine_mira_busy', residentId: 'mira', activity: 'walking', motivation: 'visit neighbors', at: now });
  assert.equal(candidates.length, 0);

  now += 10;
  coordinator.setResidentBusy('mira', false);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.residentId, 'mira');
});

test('accepted dispatch completes only after playback and records continuously audible recipients', () => {
  let now = 10_000;
  const { coordinator, candidates, perceived } = createCoordinator(() => now, ['mira', 'tobin', 'pip']);
  coordinator.routineEntered({
    eventId: 'routine_mira_path', residentId: 'mira', activity: 'walking toward the well',
    motivation: 'keep the village supplied', at: now,
  });
  const candidate = candidates[0]!;
  const reactionId = 'reaction_00001';
  assert.equal(coordinator.handle({
    version: 1, type: 'ptt.reaction.ack', eventId: String(candidate.eventId), residentId: 'mira',
    reactionId, status: 'accepted', at: ++now,
  }).status, 'accepted');
  assert.equal(coordinator.handle({
    version: 1, type: 'ptt.reaction.speech.start', eventId: String(candidate.eventId), residentId: 'mira',
    reactionId, responseId: 'response_1', itemId: 'item_1', at: ++now,
  }).status, 'started');
  coordinator.sampleActivePlayback();
  const finished = coordinator.handle({
    version: 1, type: 'ptt.reaction.speech.finish', eventId: String(candidate.eventId), residentId: 'mira',
    reactionId, responseId: 'response_1', itemId: 'item_1', playback: 'completed', transcript: 'The well path is clear.', at: ++now,
  });

  assert.equal(finished.status, 'finished');
  assert.equal(perceived.length, 1);
  assert.deepEqual(perceived[0]?.recipientIds, ['tobin', 'pip']);
  assert.equal(perceived[0]?.speakerId, 'mira');
  assert.equal(coordinator.activeCount, 2, 'the two continuously audible residents receive independent reactions');
});

test('hearing projection excludes residents who leave range during playback', () => {
  let now = 15_000;
  let sampleNumber = 0;
  const perceived: Array<Record<string, unknown>> = [];
  const candidates: Array<Record<string, unknown>> = [];
  const coordinator = new NativeResidentReactionCoordinator({
    now: () => now,
    emitCandidate: (candidate) => candidates.push(candidate),
    rememberHeardSpeech: (event) => perceived.push(event),
    residentName: (residentId) => residentId.toUpperCase(),
    samplePlayback: (speakerId) => {
      sampleNumber += 1;
      return {
        tick: now + sampleNumber,
        speakerPosition: { x: 0, y: 0, z: 0 },
        residents: ['mira', 'tobin', 'pip'].map((residentId) => ({
          residentId,
          position: { x: residentId === speakerId ? 0 : residentId === 'tobin' && sampleNumber === 2 ? 20 : 2, y: 0, z: 0 },
        })),
      };
    },
  });
  coordinator.routineEntered({ eventId: 'routine_mira_earshot', residentId: 'mira', activity: 'watering', motivation: 'care for plants', at: now });
  const candidate = candidates[0]!;
  const correlation = { eventId: String(candidate.eventId), residentId: 'mira', reactionId: 'reaction_00006' };
  coordinator.handle({ version: 1, type: 'ptt.reaction.ack', ...correlation, status: 'accepted', at: ++now });
  coordinator.handle({ version: 1, type: 'ptt.reaction.speech.start', ...correlation, responseId: 'response_6', itemId: 'item_6', at: ++now });
  coordinator.sampleActivePlayback();
  coordinator.handle({ version: 1, type: 'ptt.reaction.speech.finish', ...correlation, responseId: 'response_6', itemId: 'item_6', playback: 'completed', transcript: 'The leaves need water.', at: ++now });

  assert.deepEqual(perceived[0]?.recipientIds, ['pip']);
});

test('interruption, timeout, and duplicate terminal reports release once without heard memory', () => {
  let now = 20_000;
  const { coordinator, candidates, perceived } = createCoordinator(() => now);
  coordinator.routineEntered({
    eventId: 'routine_mira_1', residentId: 'mira', activity: 'checking the path', motivation: 'help neighbors', at: now,
  });
  const first = candidates[0]!;
  const reactionId = 'reaction_00002';
  coordinator.handle({ version: 1, type: 'ptt.reaction.ack', eventId: String(first.eventId), residentId: 'mira', reactionId, status: 'accepted', at: ++now });
  coordinator.handle({ version: 1, type: 'ptt.reaction.speech.start', eventId: String(first.eventId), residentId: 'mira', reactionId, responseId: 'response_2', itemId: 'item_2', at: ++now });
  const interrupted = coordinator.handle({
    version: 1, type: 'ptt.reaction.speech.finish', eventId: String(first.eventId), residentId: 'mira', reactionId,
    responseId: 'response_2', itemId: 'item_2', playback: 'interrupted', at: ++now,
  });
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(coordinator.activeCount, 0);
  assert.equal(perceived.length, 0);
  assert.equal(coordinator.handle({
    version: 1, type: 'ptt.reaction.speech.finish', eventId: String(first.eventId), residentId: 'mira', reactionId,
    responseId: 'response_2', itemId: 'item_2', playback: 'interrupted', at: ++now,
  }).status, 'interrupted', 'duplicate terminal report is idempotent');

  coordinator.routineEntered({ eventId: 'routine_tobin_1', residentId: 'tobin', activity: 'walking', motivation: 'visit neighbors', at: now });
  const expiring = candidates.at(-1)!;
  coordinator.tick(Number(expiring.expiresAt));
  assert.equal(coordinator.activeCount, 0);
  assert.equal(perceived.length, 0);
});

test('unavailable ACK after acceptance releases a reaction that never started audio', () => {
  let now = 25_000;
  const { coordinator, candidates, perceived } = createCoordinator(() => now);
  coordinator.routineEntered({ eventId: 'routine_pip_before_audio', residentId: 'pip', activity: 'setting out bread', motivation: 'welcome neighbors', at: now });
  const candidate = candidates[0]!;
  const correlation = {
    eventId: String(candidate.eventId), residentId: 'pip', reactionId: 'reaction_00005',
  };
  assert.equal(coordinator.handle({ version: 1, type: 'ptt.reaction.ack', ...correlation, status: 'accepted', at: ++now }).status, 'accepted');
  assert.equal(coordinator.handle({ version: 1, type: 'ptt.reaction.ack', ...correlation, status: 'unavailable', at: ++now }).status, 'unavailable');
  assert.equal(coordinator.activeCount, 0);
  assert.equal(perceived.length, 0);
});

test('a reaction can cause one further response, whose hearing is remembered without another enqueue', () => {
  let now = 30_000;
  const { coordinator, candidates, perceived } = createCoordinator(() => now, ['mira', 'tobin', 'pip']);
  coordinator.routineEntered({ eventId: 'routine_mira_2', residentId: 'mira', activity: 'baking bread', motivation: 'share food', at: now });

  const complete = (candidateIndex: number, reactionId: string, transcript: string): void => {
    const candidate = candidates[candidateIndex]!;
    const eventId = String(candidate.eventId);
    const residentId = String(candidate.residentId);
    coordinator.handle({ version: 1, type: 'ptt.reaction.ack', eventId, residentId, reactionId, status: 'accepted', at: ++now });
    coordinator.handle({ version: 1, type: 'ptt.reaction.speech.start', eventId, residentId, reactionId, responseId: `response_${candidateIndex}`, itemId: `item_${candidateIndex}`, at: ++now });
    coordinator.sampleActivePlayback();
    coordinator.handle({ version: 1, type: 'ptt.reaction.speech.finish', eventId, residentId, reactionId,
      responseId: `response_${candidateIndex}`, itemId: `item_${candidateIndex}`, playback: 'completed', transcript, at: ++now });
  };

  complete(0, 'reaction_00003', 'The bread is almost ready.');
  const second = candidates.findIndex(({ causalDepth }) => causalDepth === 2);
  assert.ok(second > 0, 'heard first reaction dispatches one second response');
  complete(second, 'reaction_00004', 'I can smell it from here.');
  assert.equal(candidates.filter(({ causalDepth }) => causalDepth === 3).length, 0);
  assert.equal(perceived.length, 2, 'depth-two speech is still remembered');
});
