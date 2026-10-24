import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeResidentPcmMixer } from './native-resident-pcm-mixer.js';

function fakeContext() {
  const sources: Array<Record<string, any>> = [];
  const gains: Array<Record<string, any>> = [];
  const panners: Array<Record<string, any>> = [];
  const makeNode = () => ({ connect() {}, disconnect() {}, gain: { setTargetAtTime(value: number) { this.value = value; } }, pan: { setTargetAtTime(value: number) { this.value = value; } } });
  const context = {
    currentTime: 10, destination: {},
    createBuffer(_channels: number, length: number, sampleRate: number) {
      return { duration: length / sampleRate, copyToChannel(samples: Float32Array) { this.samples = [...samples]; } };
    },
    createBufferSource() {
      const source: Record<string, any> = { connect() {}, disconnect() {}, start(time: number) { source.startAt = time; source.started = true; }, stop() { source.stopped = true; source.onended?.(); } };
      sources.push(source); return source;
    },
    createGain() { const node = makeNode(); gains.push(node); return node; },
    createStereoPanner() { const node = makeNode(); panners.push(node); return node; },
    async close() { (context as any).closed = true; },
  };
  return { context, sources, gains, panners };
}

test('mixes independent residents concurrently and updates live spatial gain and pan as listener moves', () => {
  const { context, sources, gains, panners } = fakeContext();
  const mixer = new NativeResidentPcmMixer({ context });
  mixer.setListenerPosition({ x: 0, y: 0, z: 0 });
  mixer.setSpeakerPosition('pip', { x: 12, y: 0, z: 0 });
  mixer.setSpeakerPosition('mira', { x: -6, y: 0, z: 0 });
  assert.equal(mixer.startUtterance({ speakerId: 'pip', utteranceId: 'r1:i1' }), true);
  assert.equal(mixer.startUtterance({ speakerId: 'mira', utteranceId: 'r2:i2' }), true);
  assert.equal(mixer.enqueue({ speakerId: 'pip', utteranceId: 'r1:i1', samples: new Float32Array(2_400) }), true);
  assert.equal(mixer.enqueue({ speakerId: 'mira', utteranceId: 'r2:i2', samples: new Float32Array(2_400) }), true);
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((source) => source.started), [true, true]);
  assert.equal(panners[0].pan.value, 1);
  assert.equal(panners[1].pan.value, -1);
  mixer.setListenerPosition({ x: 8, y: 0, z: 0 });
  assert.ok(gains[0].gain.value > 0.6);
  assert.ok(gains[1].gain.value < 0.8);
  mixer.close();
});

test('serializes chunks within one utterance, drains only after finish, and bounds queued PCM', () => {
  const { context, sources } = fakeContext();
  const ended: string[] = [];
  const mixer = new NativeResidentPcmMixer({ context, maxQueuedSeconds: 0.25, onState: (event) => { if (event.type === 'utterance-end') ended.push(event.utteranceId); } });
  mixer.setSpeakerPosition('pip', { x: 0, y: 0, z: 0 });
  mixer.startUtterance({ speakerId: 'pip', utteranceId: 'speech' });
  assert.equal(mixer.enqueue({ speakerId: 'pip', utteranceId: 'speech', samples: new Float32Array(2_400) }), true);
  assert.equal(mixer.enqueue({ speakerId: 'pip', utteranceId: 'speech', samples: new Float32Array(2_400) }), true);
  assert.equal(sources[1].startAt, sources[0].startAt + 0.1);
  assert.equal(mixer.enqueue({ speakerId: 'pip', utteranceId: 'speech', samples: new Float32Array(2_400) }), false);
  mixer.finishUtterance('speech');
  sources[0].onended();
  assert.deepEqual(ended, []);
  sources[1].onended();
  assert.deepEqual(ended, ['speech']);
  assert.equal(mixer.queuedSeconds, 0);
  mixer.close();
});

test('stopping one speaker interrupts only that resident source and drops its queue', () => {
  const { context, sources } = fakeContext();
  const mixer = new NativeResidentPcmMixer({ context });
  mixer.setSpeakerPosition('pip', { x: 0, y: 0, z: 0 });
  mixer.setSpeakerPosition('mira', { x: 1, y: 0, z: 0 });
  mixer.startUtterance({ speakerId: 'pip', utteranceId: 'pip-speech' });
  mixer.startUtterance({ speakerId: 'mira', utteranceId: 'mira-speech' });
  mixer.enqueue({ speakerId: 'pip', utteranceId: 'pip-speech', samples: new Float32Array(2_400) });
  mixer.enqueue({ speakerId: 'mira', utteranceId: 'mira-speech', samples: new Float32Array(2_400) });
  mixer.stopSpeaker('pip');
  assert.equal(sources[0].stopped, true);
  assert.equal(sources[1].stopped, undefined);
  assert.equal(mixer.utterances.has('mira-speech'), true);
  mixer.close();
});
