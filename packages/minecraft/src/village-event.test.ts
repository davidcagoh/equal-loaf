import assert from 'node:assert/strict';
import test from 'node:test';
import { asSemanticResponse, createVillageDialogueEvent, isVillagePttCommand, isVillageResidentPositionsEvent } from './village-event.ts';

test('dialogue event has a stable speaker, line, world position, listener, and timestamp contract', () => {
  const event = createVillageDialogueEvent({
    speakerId: 'mira',
    speakerName: 'MiraGardener',
    line: 'The west wheat is ready.',
    position: { x: 10, y: 64, z: -2 },
    listenerId: 'pip',
    listenerName: 'PipBaker',
    timestamp: 1234,
  });
  assert.deepEqual(event, {
    version: 1,
    type: 'village.dialogue',
    speakerId: 'mira',
    speakerName: 'MiraGardener',
    line: 'The west wheat is ready.',
    position: { x: 10, y: 64, z: -2 },
    listenerId: 'pip',
    listenerName: 'PipBaker',
    timestamp: 1234,
  });
  assert.equal(JSON.parse(JSON.stringify(event)).type, 'village.dialogue');
});

test('dialogue events can identify the trusted authored line for server-side TTS lookup', () => {
  const event = createVillageDialogueEvent({
    eventId: 'ptt-session-12345678',
    lineId: 'mira-guarded-garden-reply',
    source: 'ptt-response',
    turnId: 'ptt-session-12345678',
    speakerId: 'mira',
    speakerName: 'MiraGardener',
    line: 'The seedlings are safer uphill.',
    position: { x: 10, y: 64, z: -2 },
  });
  assert.equal(event.eventId, 'ptt-session-12345678');
  assert.equal(event.lineId, 'mira-guarded-garden-reply');
  assert.equal(event.source, 'ptt-response');
});

test('PTT IPC accepts bounded versioned commands and rejects free-text responses', () => {
  const at = Date.now();
  assert.equal(isVillagePttCommand({ version: 1, type: 'ptt.begin', turnId: 'session-12345678', at }), true);
  assert.equal(isVillagePttCommand({ version: 1, type: 'ptt.native.begin', turnId: 'session-12345678', at }), true);
  assert.equal(isVillagePttCommand({ version: 1, type: 'ptt.cancel', turnId: 'session-12345678', at }), true);
  assert.equal(isVillagePttCommand({ version: 1, type: 'ptt.complete', turnId: 'session-12345678', at, response: null }), true);
  assert.equal(isVillagePttCommand({ version: 1, type: 'ptt.complete', turnId: 'session-12345678', at, response: { playerIntent: 'greet', topic: 'general', lineId: 'mira-guarded-garden-reply' } }), true);
  assert.equal(isVillagePttCommand({ version: 1, type: 'ptt.complete', turnId: 'session-12345678', at, response: { playerIntent: 'greet', topic: 'general', line: 'free text' } }), false);
  assert.deepEqual(asSemanticResponse({ playerIntent: 'greet', topic: 'general', lineId: 'mira-guarded-garden-reply' }), {
    playerIntent: 'greet', topic: 'general', lineId: 'mira-guarded-garden-reply',
  });
  assert.equal(asSemanticResponse({ playerIntent: 'greet', topic: 'general', line: 'free text' }), null);
  assert.equal(isVillagePttCommand({ version: 1, type: 'ptt.begin', turnId: 'short', at }), false);
});

test('native speech IPC binds opaque response IDs to a resident session and rejects interrupted text', () => {
  const common = { version: 1, turnId: 'turn-12345678', residentSessionId: 'resident-session-1234', at: Date.now() };
  assert.equal(isVillagePttCommand({ ...common, type: 'ptt.session.bind' }), true);
  assert.equal(isVillagePttCommand({ ...common, type: 'ptt.native.end' }), true);
  assert.equal(isVillagePttCommand({ ...common, type: 'ptt.speech.start', responseId: 'resp_1', itemId: 'item_1' }), true);
  assert.equal(isVillagePttCommand({
    ...common, type: 'ptt.speech.finish', responseId: 'resp_1', itemId: 'item_1', playback: 'completed', transcript: 'A path is flooded.',
  }), true);
  assert.equal(isVillagePttCommand({
    ...common, type: 'ptt.speech.finish', responseId: 'resp_1', itemId: 'item_1', playback: 'interrupted',
  }), true);
  assert.equal(isVillagePttCommand({
    ...common, type: 'ptt.speech.finish', responseId: 'resp_1', itemId: 'item_1', playback: 'interrupted', transcript: 'unplayed words',
  }), false);
  assert.equal(isVillagePttCommand({
    ...common, type: 'ptt.speech.finish', responseId: 'resp_1', itemId: 'item_1', playback: 'completed', transcript: 'x'.repeat(1_001),
  }), false);
  assert.equal(isVillagePttCommand({
    ...common, type: 'ptt.speech.start', responseId: 'resp_1', itemId: 'item_1', speakerId: 'mira',
  }), false);
});

test('resident position snapshots accept only bounded, authoritative-shaped coordinates', () => {
  const event = {
    type: 'village.residents', timestamp: Date.now(),
    residents: [{ residentId: 'mira', name: 'Anna', position: { x: 1.5, y: 64, z: -2 } }],
  };
  assert.equal(isVillageResidentPositionsEvent(event), true);
  assert.equal(isVillageResidentPositionsEvent({ ...event, extra: true }), false);
  assert.equal(isVillageResidentPositionsEvent({ ...event, residents: [{ ...event.residents[0], residentId: 'bad id' }] }), false);
  assert.equal(isVillageResidentPositionsEvent({ ...event, residents: [{ ...event.residents[0], position: { x: Infinity, y: 64, z: 0 } }] }), false);
  assert.equal(isVillageResidentPositionsEvent({ ...event, residents: [event.residents[0], event.residents[0]] }), false);
});
