const MAX_RESPONSE_IDS = 64;
const SAFE_ID = /^[A-Za-z0-9:_-]{1,128}$/;

export function calculatePlayedAudioEndMs(chunks, now) {
  if (!Array.isArray(chunks) || !Number.isFinite(now)) return 0;
  const playedSeconds = chunks.reduce((total, chunk) => {
    if (!Number.isFinite(chunk?.startAt) || !Number.isFinite(chunk?.duration) || chunk.duration <= 0) return total;
    return total + Math.max(0, Math.min(chunk.duration, now - chunk.startAt));
  }, 0);
  return Math.floor((playedSeconds + 1e-9) * 1_000);
}

export function audioOutputTime(context) {
  if (!context) return 0;
  try {
    const timestamp = context.getOutputTimestamp?.();
    if (Number.isFinite(timestamp?.contextTime)) return Math.max(0, timestamp.contextTime);
  } catch { /* fall back to a conservative estimate below */ }
  if (!Number.isFinite(context.currentTime)) return 0;
  const latencies = [context.baseLatency, context.outputLatency].filter((value) => Number.isFinite(value) && value >= 0);
  if (!latencies.length) return 0;
  const latency = latencies.reduce((sum, value) => sum + value, 0);
  return Math.max(0, context.currentTime - latency);
}

/** Tracks one native audio response so barge-in can synchronize heard audio with server history. */
export function createNativeResponsePlayback() {
  let active = null;
  let ignoredResponseIds = [];

  const ignore = (responseId) => {
    ignoredResponseIds = [...ignoredResponseIds.filter((id) => id !== responseId), responseId].slice(-MAX_RESPONSE_IDS);
  };

  const truncationFor = (record) => record.itemId ? {
    type: 'conversation.item.truncate',
    item_id: record.itemId,
    content_index: record.contentIndex,
    audio_end_ms: record.playedAudioEndMs,
  } : null;

  return {
    begin(responseId) {
      if (typeof responseId !== 'string' || !SAFE_ID.test(responseId) || ignoredResponseIds.includes(responseId) || active) return null;
      active = { responseId, itemId: null, contentIndex: 0, chunks: [], done: false, interrupted: false, truncationSent: false };
      return active;
    },

    addChunk(responseId, chunk) {
      if (!active || active.responseId !== responseId || active.interrupted) return false;
      if (typeof chunk?.itemId === 'string' && SAFE_ID.test(chunk.itemId)) active.itemId = chunk.itemId;
      if (Number.isSafeInteger(chunk?.contentIndex) && chunk.contentIndex >= 0) active.contentIndex = chunk.contentIndex;
      active.chunks.push({ startAt: chunk.startAt, duration: chunk.duration });
      return true;
    },

    finish(responseId) {
      if (!active || active.responseId !== responseId) return null;
      active.done = true;
      if (!active.interrupted) return { interrupted: false, truncate: null };
      return this.truncateIfNeeded(active);
    },

    interrupt(now) {
      if (!active || active.interrupted) return null;
      const record = active;
      record.interrupted = true;
      record.playedAudioEndMs = calculatePlayedAudioEndMs(record.chunks, now);
      ignore(record.responseId);
      return {
        responseId: record.responseId,
        cancel: !record.done,
        truncate: record.done ? this.truncateIfNeeded(record).truncate : null,
      };
    },

    truncateIfNeeded(record = active) {
      if (!record?.interrupted || !record.done || record.truncationSent) return { interrupted: true, truncate: null };
      record.truncationSent = true;
      return { interrupted: true, truncate: truncationFor(record) };
    },

    acceptsAudio(responseId) {
      return typeof responseId === 'string' && !ignoredResponseIds.includes(responseId)
        && active?.responseId === responseId && !active.interrupted && !active.done;
    },

    clear(responseId) {
      if (active?.responseId === responseId) active = null;
    },

    reset() {
      active = null;
      ignoredResponseIds = [];
    },
  };
}
