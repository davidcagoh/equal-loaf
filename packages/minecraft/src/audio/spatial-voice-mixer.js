export const DEFAULT_MAX_DISTANCE = 48;

export function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function attenuationForDistance(distance, maxDistance = DEFAULT_MAX_DISTANCE) {
  if (!Number.isFinite(distance) || distance < 0 || distance >= maxDistance) return 0;
  return Math.max(0, 1 - distance / maxDistance);
}

export function panForPosition(listener, source) {
  const dx = source.x - listener.x;
  const dz = source.z - listener.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return 0;
  const yaw = Number.isFinite(listener.yaw) ? listener.yaw : 0;
  return Math.max(-1, Math.min(1, (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / length));
}

/** A bounded WebAudio mixer with one FIFO per speaker and a global source cap. */
export class SpatialVoiceMixer {
  constructor({ context, maxConcurrency = 3, maxDistance = DEFAULT_MAX_DISTANCE, onState = () => {} }) {
    if (!context) throw new TypeError('An AudioContext is required');
    this.context = context;
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
    this.maxDistance = maxDistance;
    this.onState = onState;
    this.listener = null;
    this.channels = new Map();
    this.pending = [];
    this.active = new Map();
    this.sequence = 0;
    this.closed = false;
  }

  setListenerPosition(position) {
    if (!validPosition(position)) return;
    this.listener = { ...position };
    for (const item of this.pending) this.#updatePendingGain(item);
    for (const record of this.active.values()) this.#updateRecord(record);
  }

  enqueue({ speakerId, utteranceId, buffer, position, priority = 0 }) {
    if (this.closed || !speakerId || !utteranceId || !buffer || !validPosition(position)) return false;
    if (this.active.has(utteranceId) || this.pending.some((item) => item.utteranceId === utteranceId)) return false;
    const channel = this.channels.get(speakerId) ?? [];
    this.channels.set(speakerId, channel);
    const item = { speakerId, utteranceId, buffer, position: { ...position }, priority, sequence: this.sequence++, channel, queuedAt: Date.now() };
    channel.push(item);
    if (channel.length === 1) this.#queue(item);
    return true;
  }

  #queue(item) {
    this.#updatePendingGain(item);
    this.pending.push(item);
    this.pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    this.#pump();
  }

  #updatePendingGain(item) {
    const distance = this.listener ? distanceBetween(this.listener, item.position) : 0;
    item.gain = this.listener ? attenuationForDistance(distance, this.maxDistance) : 1;
    item.pan = this.listener ? panForPosition(this.listener, item.position) : 0;
  }

  #updateRecord(record) {
    const gain = this.listener ? attenuationForDistance(distanceBetween(this.listener, record.item.position), this.maxDistance) : 1;
    const pan = this.listener ? panForPosition(this.listener, record.item.position) : 0;
    record.gainNode.gain.setTargetAtTime(gain, this.context.currentTime, 0.03);
    record.panner.pan.setTargetAtTime(pan, this.context.currentTime, 0.03);
  }

  #pump() {
    while (!this.closed && this.active.size < this.maxConcurrency && this.pending.length) {
      const item = this.pending.shift();
      if (item.gain <= 0) { this.#finishItem(item, false); continue; }
      this.#start(item);
    }
  }

  #start(item) {
    const source = this.context.createBufferSource();
    const gainNode = this.context.createGain();
    const panner = this.context.createStereoPanner();
    source.buffer = item.buffer;
    source.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(this.context.destination);
    const record = { item, source, gainNode, panner };
    this.active.set(item.utteranceId, record);
    this.#updateRecord(record);
    source.onended = () => this.#finishItem(item, true);
    this.onState({ type: 'start', speakerId: item.speakerId, utteranceId: item.utteranceId });
    source.start();
  }

  #finishItem(item, wasActive) {
    if (wasActive) {
      const record = this.active.get(item.utteranceId);
      if (!record) return;
      this.active.delete(item.utteranceId);
      record.source.onended = null;
      try { record.source.disconnect(); } catch {}
      try { record.gainNode.disconnect(); } catch {}
      try { record.panner.disconnect(); } catch {}
    } else {
      if (!this.pending.includes(item)) return;
      this.pending = this.pending.filter((pending) => pending !== item);
    }
    const channel = this.channels.get(item.speakerId);
    if (channel) {
      const index = channel.indexOf(item);
      if (index >= 0) channel.splice(index, 1);
      if (channel.length) {
        if (!this.pending.some((pending) => pending === channel[0]) && ![...this.active.values()].some((entry) => entry.item === channel[0])) this.#queue(channel[0]);
      } else this.channels.delete(item.speakerId);
    }
    this.onState({ type: 'end', speakerId: item.speakerId, utteranceId: item.utteranceId });
    this.#pump();
  }

  stopSpeaker(speakerId) {
    const channel = this.channels.get(speakerId) ?? [];
    for (const item of [...channel]) {
      const record = this.active.get(item.utteranceId);
      if (record) { try { record.source.stop(); } catch {} this.#finishItem(item, true); }
      else this.#finishItem(item, false);
    }
  }

  stopAll() {
    for (const speakerId of [...this.channels.keys()]) this.stopSpeaker(speakerId);
  }

  close() {
    if (this.closed) return;
    this.stopAll();
    this.closed = true;
    void this.context.close?.();
  }
}

function validPosition(value) {
  return Boolean(value && ['x', 'y', 'z'].every((key) => Number.isFinite(value[key])));
}
