import assert from 'node:assert/strict';
import test from 'node:test';
import { createVillageDialogueEvent } from './village-event.ts';

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
