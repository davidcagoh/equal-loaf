import { attenuationForDistance, distanceBetween, panForPosition } from './spatial-voice-mixer.js';

export const NATIVE_PCM_RATE = 24_000;
export const MAX_NATIVE_UTTERANCE_SECONDS = 120;
export const MAX_NATIVE_QUEUED_SECONDS = 60;

/** Streams PCM chunks from independently positioned resident sources into Web Audio. */
export class NativeResidentPcmMixer {
  constructor({ context, maxDistance = 48, maxQueuedSeconds = MAX_NATIVE_QUEUED_SECONDS, onState = () => {} }) {
    if (!context) throw new TypeError('An AudioContext is required');
    this.context = context;
    this.maxDistance = maxDistance;
    this.maxQueuedSeconds = maxQueuedSeconds;
    this.onState = onState;
    this.listener = null;
    this.speakers = new Map();
    this.utterances = new Map();
    this.closed = false;
    this.queuedSeconds = 0;
  }

  setListenerPosition(position) {
    if (!validPosition(position)) return false;
    this.listener = { ...position };
    for (const utterance of this.utterances.values()) for (const record of utterance.sources) this.#update(record);
    return true;
  }

  setSpeakerPosition(speakerId, position) {
    if (typeof speakerId !== 'string' || !speakerId || !validPosition(position)) return false;
    this.speakers.set(speakerId, { ...position });
    for (const utterance of this.utterances.values()) {
      if (utterance.speakerId === speakerId) for (const record of utterance.sources) this.#update(record);
    }
    return true;
  }

  startUtterance({ speakerId, utteranceId }) {
    if (this.closed || !speakerId || !utteranceId || this.utterances.has(utteranceId)) return false;
    this.utterances.set(utteranceId, {
      speakerId, utteranceId, sources: new Set(), cursor: this.context.currentTime,
      duration: 0, finished: false,
    });
    return true;
  }

  enqueue({ speakerId, utteranceId, samples }) {
    const utterance = this.utterances.get(utteranceId);
    if (this.closed || !utterance || utterance.speakerId !== speakerId
      || !(samples instanceof Float32Array) || samples.length === 0) return false;
    const duration = samples.length / NATIVE_PCM_RATE;
    if (!Number.isFinite(duration) || utterance.duration + duration > MAX_NATIVE_UTTERANCE_SECONDS
      || this.queuedSeconds + duration > this.maxQueuedSeconds) return false;
    const position = this.speakers.get(speakerId);
    if (!position) return false;

    const buffer = this.context.createBuffer(1, samples.length, NATIVE_PCM_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    const gainNode = this.context.createGain();
    const panner = this.context.createStereoPanner();
    source.buffer = buffer;
    source.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(this.context.destination);
    const record = { utterance, source, gainNode, panner, duration, startAt: Math.max(utterance.cursor, this.context.currentTime) };
    utterance.sources.add(record);
    utterance.cursor = record.startAt + duration;
    utterance.duration += duration;
    this.queuedSeconds += duration;
    this.#update(record);
    source.onended = () => this.#sourceEnded(record);
    source.start(record.startAt);
    this.onState({ type: 'chunk-start', speakerId, utteranceId, duration });
    return true;
  }

  finishUtterance(utteranceId) {
    const utterance = this.utterances.get(utteranceId);
    if (!utterance) return false;
    utterance.finished = true;
    this.#finishIfDrained(utterance);
    return true;
  }

  stopUtterance(utteranceId) {
    const utterance = this.utterances.get(utteranceId);
    if (!utterance) return false;
    for (const record of [...utterance.sources]) {
      record.source.onended = null;
      try { record.source.stop(); } catch { /* already ended */ }
      this.#releaseSource(record);
    }
    this.utterances.delete(utteranceId);
    this.onState({ type: 'utterance-end', speakerId: utterance.speakerId, utteranceId, playback: 'interrupted' });
    return true;
  }

  stopSpeaker(speakerId) {
    for (const utterance of [...this.utterances.values()]) if (utterance.speakerId === speakerId) this.stopUtterance(utterance.utteranceId);
  }

  stopAll() {
    for (const utteranceId of [...this.utterances.keys()]) this.stopUtterance(utteranceId);
  }

  close() {
    if (this.closed) return;
    this.stopAll();
    this.closed = true;
    void this.context.close?.();
  }

  #update(record) {
    const position = this.speakers.get(record.utterance.speakerId);
    const listener = this.listener;
    const distance = listener && position ? distanceBetween(listener, position) : 0;
    const gain = listener ? attenuationForDistance(distance, this.maxDistance) : 1;
    const pan = listener && position ? panForPosition(listener, position) : 0;
    record.gainNode.gain.setTargetAtTime(gain, this.context.currentTime, 0.03);
    record.panner.pan.setTargetAtTime(pan, this.context.currentTime, 0.03);
  }

  #sourceEnded(record) {
    if (!record.utterance.sources.has(record)) return;
    this.#releaseSource(record);
    this.#finishIfDrained(record.utterance);
  }

  #releaseSource(record) {
    record.utterance.sources.delete(record);
    this.queuedSeconds = Math.max(0, this.queuedSeconds - record.duration);
    try { record.source.disconnect(); } catch { /* already disconnected */ }
    try { record.gainNode.disconnect(); } catch { /* already disconnected */ }
    try { record.panner.disconnect(); } catch { /* already disconnected */ }
  }

  #finishIfDrained(utterance) {
    if (!utterance.finished || utterance.sources.size > 0 || this.utterances.get(utterance.utteranceId) !== utterance) return;
    this.utterances.delete(utterance.utteranceId);
    this.onState({ type: 'utterance-end', speakerId: utterance.speakerId, utteranceId: utterance.utteranceId, playback: 'completed' });
  }
}

function validPosition(value) {
  return Boolean(value && ['x', 'y', 'z'].every((key) => Number.isFinite(value[key])));
}
