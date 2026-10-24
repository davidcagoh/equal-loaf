export const NATIVE_REALTIME_RATE = 24_000;
const MAX_DELTA_BASE64_CHARS = 256_000;

export function nativeCaptureFailureReason(stage, error) {
  const name = error && typeof error === 'object' && typeof error.name === 'string' ? error.name : '';
  if (stage === 'microphone') {
    if (name === 'NotAllowedError') return 'microphone_permission_denied';
    if (name === 'SecurityError') return 'microphone_security_blocked';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'microphone_device_missing';
    if (name === 'NotReadableError' || name === 'AbortError') return 'microphone_device_busy';
    return 'microphone_unavailable';
  }
  if (stage === 'audio_context') return 'audio_context_unavailable';
  if (stage === 'worklet') return 'audio_worklet_unavailable';
  return 'capture_graph_unavailable';
}

export async function acquireNativeCapture({ isCurrent, getUserMedia, resumeContext, prepareWorklet, createCapture, stopStream, disconnectCapture }) {
  let stream;
  let capture;
  let stage = 'microphone';
  try {
    stream = await getUserMedia();
    if (!isCurrent()) { stopStream(stream); return { capture: null, reason: 'capture_cancelled' }; }
    stage = 'audio_context';
    await resumeContext();
    if (!isCurrent()) { stopStream(stream); return { capture: null, reason: 'capture_cancelled' }; }
    stage = 'worklet';
    await prepareWorklet();
    if (!isCurrent()) { stopStream(stream); return { capture: null, reason: 'capture_cancelled' }; }
    stage = 'capture_graph';
    capture = createCapture(stream);
    if (!isCurrent()) {
      disconnectCapture(capture);
      stopStream(stream);
      return { capture: null, reason: 'capture_cancelled' };
    }
    return { capture, reason: null };
  } catch (error) {
    if (capture) disconnectCapture(capture);
    if (stream) stopStream(stream);
    return { capture: null, reason: nativeCaptureFailureReason(stage, error) };
  }
}

export function createRetryableWorkletLoader(load) {
  let pending;
  return () => {
    if (!pending) {
      const attempt = Promise.resolve().then(load);
      const retryable = attempt.catch((error) => {
        if (pending === retryable) pending = undefined;
        throw error;
      });
      pending = retryable;
    }
    return pending;
  };
}

export function encodePcm16(samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0) return '';
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 32_768 : sample * 32_767, true);
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

export function decodePcm16Base64Chunk(value, pendingByte = null) {
  if (typeof value !== 'string' || value.length > MAX_DELTA_BASE64_CHARS
    || (pendingByte !== null && (!Number.isInteger(pendingByte) || pendingByte < 0 || pendingByte > 255))) {
    return { valid: false, reason: typeof value === 'string' && value.length > MAX_DELTA_BASE64_CHARS ? 'encoded_too_large' : 'invalid_input', samples: null, pendingByte: null, encodedChars: typeof value === 'string' ? value.length : null, decodedBytes: null };
  }
  const paddingIndex = value.indexOf('=');
  const unpaddedLength = paddingIndex < 0 ? value.length : paddingIndex;
  if (value !== '' && (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    || unpaddedLength % 4 === 1
    || (paddingIndex >= 0 && (value.length % 4 !== 0 || unpaddedLength % 4 !== (value.endsWith('==') ? 2 : 3))))) {
    return { valid: false, reason: 'malformed_base64', samples: null, pendingByte: null, encodedChars: value.length, decodedBytes: null };
  }
  let binary;
  try { binary = value === '' ? '' : atob(value); } catch {
    return { valid: false, reason: 'malformed_base64', samples: null, pendingByte: null, encodedChars: value.length, decodedBytes: null };
  }
  if (binary.length > 192_000) {
    return { valid: false, reason: 'decoded_too_large', samples: null, pendingByte: null, encodedChars: value.length, decodedBytes: binary.length };
  }
  const bytes = new Uint8Array(binary.length + (pendingByte === null ? 0 : 1));
  if (pendingByte !== null) bytes[0] = pendingByte;
  for (let index = 0; index < binary.length; index += 1) bytes[index + (pendingByte === null ? 0 : 1)] = binary.charCodeAt(index);
  const completeByteCount = bytes.length - (bytes.length % 2);
  const samples = new Float32Array(completeByteCount / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, completeByteCount);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32_768;
  return {
    valid: true, reason: null, samples,
    pendingByte: completeByteCount < bytes.length ? bytes[bytes.length - 1] : null,
    encodedChars: value.length, decodedBytes: binary.length,
  };
}

export function pcmRemainderKey(responseId, itemId, contentIndex) {
  return JSON.stringify([responseId, itemId, contentIndex]);
}

export function isNativeRealtimeSessionAck(event, voice, requireInputTranscription = false) {
  if (!event || typeof event !== 'object' || !['session.created', 'session.updated'].includes(event.type)) return false;
  const session = event.session;
  const input = session?.audio?.input;
  const output = session?.audio?.output;
  const modalities = session?.output_modalities;
  return Array.isArray(modalities) && modalities.length === 1 && modalities[0] === 'audio'
    && input?.format?.type === 'audio/pcm' && input.format.rate === NATIVE_REALTIME_RATE && input.turn_detection === null
    && (!requireInputTranscription || (input.transcription?.model === 'higgs-stt-3.1' && input.transcription.language === 'en'))
    && output?.format?.type === 'audio/pcm' && output.format.rate === NATIVE_REALTIME_RATE && output.voice === voice
    && (!Array.isArray(session.tools) || session.tools.length === 0)
    && (session.tool_choice === undefined || session.tool_choice === 'none');
}

export function evaluateNativeAudioChunk({ hasContext, responseAccepted, samples, responseSeconds, queuedSeconds,
  sampleRate = NATIVE_REALTIME_RATE, maxResponseSeconds = 120, maxQueuedSeconds = 60 }) {
  if (!hasContext) return { accepted: false, reason: 'audio_context_unavailable' };
  if (!responseAccepted) return { accepted: false, reason: 'stale_response' };
  if (!(samples instanceof Float32Array) || samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { accepted: false, reason: 'invalid_pcm_delta' };
  }
  const duration = samples.length / sampleRate;
  if (!Number.isFinite(responseSeconds) || responseSeconds + duration > maxResponseSeconds) return { accepted: false, reason: 'response_duration_limit' };
  if (!Number.isFinite(queuedSeconds) || queuedSeconds + duration > maxQueuedSeconds) return { accepted: false, reason: 'output_queue_limit' };
  return { accepted: true, duration };
}

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
  } catch { /* use conservative latency estimate */ }
  if (!Number.isFinite(context.currentTime)) return 0;
  const latencies = [context.baseLatency, context.outputLatency].filter((value) => Number.isFinite(value) && value >= 0);
  if (!latencies.length) return 0;
  return Math.max(0, context.currentTime - latencies.reduce((sum, value) => sum + value, 0));
}

/** Tracks one response so barge-in can cancel generation and truncate unheard audio. */
export function createNativeResponsePlayback() {
  let active = null;
  let ignoredResponseIds = [];
  const ignore = (responseId) => { ignoredResponseIds = [...ignoredResponseIds.filter((id) => id !== responseId), responseId].slice(-64); };
  const truncationFor = (record) => record.itemId ? {
    type: 'conversation.item.truncate', item_id: record.itemId,
    content_index: record.contentIndex, audio_end_ms: record.playedAudioEndMs,
  } : null;
  return {
    begin(responseId) {
      if (typeof responseId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(responseId) || ignoredResponseIds.includes(responseId) || active) return null;
      active = { responseId, itemId: null, contentIndex: 0, chunks: [], done: false, interrupted: false, truncationSent: false };
      return active;
    },
    addChunk(responseId, chunk) {
      if (!active || active.responseId !== responseId || active.interrupted) return false;
      if (typeof chunk?.itemId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(chunk.itemId)) active.itemId = chunk.itemId;
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
      return { responseId: record.responseId, cancel: !record.done,
        truncate: record.done ? this.truncateIfNeeded(record).truncate : null };
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
    clear(responseId) { if (active?.responseId === responseId) active = null; },
    reset() { active = null; ignoredResponseIds = []; },
  };
}
