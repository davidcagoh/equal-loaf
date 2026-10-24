import assert from 'node:assert/strict';
import test from 'node:test';
import { asSemanticResponse, createVillageDialogueEvent, isVillagePttCommand } from './village-event.ts';

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
