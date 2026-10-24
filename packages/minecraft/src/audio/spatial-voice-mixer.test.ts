import assert from 'node:assert/strict';
import test from 'node:test';
import { SpatialVoiceMixer, attenuationForDistance, panForPosition } from './spatial-voice-mixer.js';

function fakeContext() {
  const sources = [];
  const makeNode = () => ({ connect() {}, disconnect() {}, gain: { setTargetAtTime(value) { this.value = value; } }, pan: { setTargetAtTime(value) { this.value = value; } } });
  const context = {
    currentTime: 0, destination: {},
    createBufferSource() { const source = { connect() {}, disconnect() {}, start() { source.started = true; }, stop() { source.onended?.(); } }; sources.push(source); return source; },
    createGain: makeNode,
    createStereoPanner: makeNode,
    async close() { context.closed = true; },
  };
  return { context, sources };
}

test('attenuation and stereo pan respond to distance and listener yaw', () => {
  assert.equal(attenuationForDistance(0), 1);
  assert.equal(attenuationForDistance(24), 0.5);
  assert.equal(attenuationForDistance(48), 0);
  assert.equal(panForPosition({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }), 1);
  assert.ok(Math.abs(panForPosition({ x: 0, y: 0, z: 0, yaw: Math.PI / 2 }, { x: 0, y: 0, z: 5 }) + 1) < 1e-9);
});

test('mixer layers different speakers, serializes each speaker, and caps active sources', () => {
  const { context, sources } = fakeContext();
  const mixer = new SpatialVoiceMixer({ context, maxConcurrency: 2 });
  mixer.setListenerPosition({ x: 0, y: 0, z: 0 });
  mixer.enqueue({ speakerId: 'mira', utteranceId: 'm1', buffer: {}, position: { x: 1, y: 0, z: 0 } });
  mixer.enqueue({ speakerId: 'mira', utteranceId: 'm2', buffer: {}, position: { x: 2, y: 0, z: 0 } });
  mixer.enqueue({ speakerId: 'pip', utteranceId: 'p1', buffer: {}, position: { x: -1, y: 0, z: 0 } });
  mixer.enqueue({ speakerId: 'tobin', utteranceId: 't1', buffer: {}, position: { x: 0, y: 0, z: 1 } });
  assert.equal(sources.filter((source) => source.started).length, 2);
  sources[0].onended();
  assert.equal(sources.filter((source) => source.started).length, 3);
  assert.equal(sources[2]?.started, true);
  assert.equal(mixer.active.size, 2);
  mixer.close();
  assert.equal(mixer.active.size, 0);
  assert.equal(context.closed, true);
});

test('mixer starts higher-priority queued sources first and rejects sources outside its audible range', () => {
  const { context, sources } = fakeContext();
  const states = [];
  const mixer = new SpatialVoiceMixer({ context, maxConcurrency: 1, onState: (state) => states.push(state) });
  mixer.setListenerPosition({ x: 0, y: 0, z: 0 });
  mixer.enqueue({ speakerId: 'blocker', utteranceId: 'active', buffer: {}, position: { x: 1, y: 0, z: 0 } });
  mixer.enqueue({ speakerId: 'far', utteranceId: 'low-priority', buffer: {}, position: { x: 2, y: 0, z: 0 }, priority: 1 });
  mixer.enqueue({ speakerId: 'near', utteranceId: 'high-priority', buffer: {}, position: { x: 3, y: 0, z: 0 }, priority: 5 });
  mixer.enqueue({ speakerId: 'distant', utteranceId: 'outside-range', buffer: {}, position: { x: 48, y: 0, z: 0 }, priority: 10 });

  assert.deepEqual(states.filter(({ type }) => type === 'start').map(({ utteranceId }) => utteranceId), ['active']);
  assert.equal(states.some(({ type, utteranceId }) => type === 'start' && utteranceId === 'outside-range'), false);
  assert.equal(mixer.active.has('outside-range'), false);

  sources[0].onended();
  assert.equal(states.filter(({ type }) => type === 'start').at(-1)?.utteranceId, 'high-priority');
  sources[1].onended();
  assert.equal(states.filter(({ type }) => type === 'start').at(-1)?.utteranceId, 'low-priority');
  mixer.close();
});

test('stopSpeaker releases only that speaker and removes queued clips', () => {
  const { context } = fakeContext();
  const mixer = new SpatialVoiceMixer({ context, maxConcurrency: 1 });
  mixer.enqueue({ speakerId: 'mira', utteranceId: 'm1', buffer: {}, position: { x: 1, y: 0, z: 0 } });
  mixer.enqueue({ speakerId: 'mira', utteranceId: 'm2', buffer: {}, position: { x: 2, y: 0, z: 0 } });
  mixer.enqueue({ speakerId: 'pip', utteranceId: 'p1', buffer: {}, position: { x: -1, y: 0, z: 0 } });
  mixer.stopSpeaker('mira');
  assert.equal(mixer.channels.has('mira'), false);
  assert.equal(mixer.active.size, 1);
  assert.equal(mixer.active.has('p1'), true);
  mixer.stopAll();
  assert.equal(mixer.active.size, 0);
});
