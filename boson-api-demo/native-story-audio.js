import { audioOutputTime, createNativeResponsePlayback, evaluateNativeAudioChunk } from './native-response-playback.js';

const RATE = 24_000;
const REALTIME_URL = 'wss://api.boson.ai/v1/realtime';
const MAX_DELTA_BASE64_CHARS = 256_000;
const MAX_QUEUED_OUTPUT_SECONDS = 60;
const MAX_OUTPUT_SECONDS_PER_RESPONSE = 120;
const MAX_PENDING_PCM_REMAINDERS = 64;
const VALID_PROVIDER_CODES = new Set([
  'invalid_request_error', 'authentication_error', 'rate_limit_exceeded', 'server_error',
  'session_expired', 'response_cancel_not_active', 'input_audio_buffer_commit_empty',
]);

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
    const streamPromise = getUserMedia();
    stream = await streamPromise;
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

export function decodePcm16Base64Audio(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DELTA_BASE64_CHARS) return null;
  let binary;
  try { binary = atob(value); } catch { return null; }
  if (binary.length === 0 || binary.length % 2 !== 0 || binary.length > 192_000) return null;
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32_768;
  return samples;
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
    valid: true,
    reason: null,
    samples,
    pendingByte: completeByteCount < bytes.length ? bytes[bytes.length - 1] : null,
    encodedChars: value.length,
    decodedBytes: binary.length,
  };
}

export function summarizeRealtimeAudioUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const inputDetails = usage.input_token_details && typeof usage.input_token_details === 'object'
    ? usage.input_token_details : {};
  const outputDetails = usage.output_token_details && typeof usage.output_token_details === 'object'
    ? usage.output_token_details : {};
  const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    totalTokens: safeCount(usage.total_tokens),
    inputTokens: safeCount(usage.input_tokens),
    outputTokens: safeCount(usage.output_tokens),
    inputAudioTokens: safeCount(inputDetails.audio_tokens ?? usage.input_audio_tokens),
    outputAudioTokens: safeCount(outputDetails.audio_tokens ?? usage.output_audio_tokens),
  };
}

export function isNativeRealtimeSessionAck(event, voice = 'chloe') {
  if (!event || typeof event !== 'object' || !['session.created', 'session.updated'].includes(event.type)) return false;
  const session = event.session;
  const input = session?.audio?.input;
  const output = session?.audio?.output;
  const modalities = session?.output_modalities;
  return Array.isArray(modalities) && modalities.length === 1 && modalities[0] === 'audio'
    && input?.format?.type === 'audio/pcm' && input.format.rate === RATE && input.turn_detection === null
    && output?.format?.type === 'audio/pcm' && output.format.rate === RATE && output.voice === voice
    && (!Array.isArray(session.tools) || session.tools.length === 0)
    && (session.tool_choice === undefined || session.tool_choice === 'none');
}

function encodePcm16(samples) {
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

function safeProviderCode(value) {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value) && VALID_PROVIDER_CODES.has(value)
    ? value : 'provider_error';
}

function safeProviderId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value) ? value : null;
}

export function pcmRemainderKey(responseId, itemId, contentIndex) {
  return JSON.stringify([responseId, itemId, contentIndex]);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function estimateRealtimeAudioUsd(inputSeconds, outputSeconds) {
  const inputCost = Math.max(0, Number.isFinite(inputSeconds) ? inputSeconds : 0) / 60 * 0.0023;
  const outputCost = Math.max(0, Number.isFinite(outputSeconds) ? outputSeconds : 0) / 60 * 0.014;
  return Number((inputCost + outputCost).toFixed(6));
}

function bootNativePtt(root, resident) {
  const byId = (id) => root.querySelector(`#${id}`);
  const startButton = byId('start-session');
  const endButton = byId('end-session');
  const talkButton = byId('talk');
  const state = {
    sessionId: null,
    expiresAt: 0,
    socket: null,
    audioContext: null,
    capture: null,
    held: false,
    holdSource: null,
    sessionReady: false,
    sessionStarting: false,
    waitingForCommit: false,
    responseInProgress: false,
    activeResponseId: null,
    interruptionPending: null,
    commitAfterInterruption: false,
    cancelRequestedAt: 0,
    inputSamples: 0,
    outputSamples: 0,
    turns: 0,
    sessionStartedAt: 0,
    playHead: 0,
    queuedOutputSeconds: 0,
    responseOutputSeconds: 0,
    playingSources: new Set(),
    pendingPcmBytes: new Map(),
    stoppedOutputResponses: new Set(),
    responsePlayback: createNativeResponsePlayback(),
    providerTokens: null,
    timers: new Set(),
    ackTimer: null,
    sessionGeneration: 0,
    heartbeatTimer: null,
    captureGeneration: 0,
  };
  const stoppedStreams = new WeakSet();

  const diagnostic = (message) => {
    const list = byId('diagnostic-list');
    const item = document.createElement('li');
    item.textContent = message;
    list.append(item);
    while (list.children.length > 12) list.firstElementChild.remove();
  };
  const discardPcmRemainders = (reason, onlyResponseId = null) => {
    for (const [key, remainder] of state.pendingPcmBytes) {
      if (onlyResponseId && remainder.responseId !== onlyResponseId) continue;
      diagnostic(`Incomplete PCM sample byte discarded · reason=${reason} · response=${remainder.responseId}`
        + ` · encoded_chars=${remainder.encodedChars} · decoded_bytes=${remainder.decodedBytes}`);
      state.pendingPcmBytes.delete(key);
    }
  };
  const status = (id, value, stateName = '') => {
    const node = byId(id);
    node.textContent = value;
    node.dataset.state = stateName;
  };
  const updateUsage = () => {
    const inputSeconds = state.inputSamples / RATE;
    const outputSeconds = state.outputSamples / RATE;
    byId('turn-count').textContent = String(state.turns);
    byId('input-duration').textContent = formatDuration(inputSeconds);
    byId('output-duration').textContent = formatDuration(outputSeconds);
    byId('cost-estimate').textContent = `$${estimateRealtimeAudioUsd(inputSeconds, outputSeconds).toFixed(6)}`;
    if (state.providerTokens) {
      const tokens = [state.providerTokens.inputAudioTokens, state.providerTokens.outputAudioTokens]
        .map((value) => value === null ? '—' : String(value)).join(' / ');
      byId('audio-tokens').textContent = tokens;
    }
    if (state.sessionStartedAt) byId('session-age').textContent = formatDuration((Date.now() - state.sessionStartedAt) / 1_000);
    if (state.expiresAt) byId('credential-expiry').textContent = new Date(state.expiresAt * 1_000).toLocaleTimeString();
  };
  const refreshControls = () => {
    startButton.disabled = state.sessionStarting || Boolean(state.sessionId);
    endButton.disabled = !state.sessionId && !state.sessionStarting;
    talkButton.disabled = !state.sessionReady || state.waitingForCommit;
    talkButton.textContent = state.held ? 'Release to send' : 'Hold P to talk';
    talkButton.setAttribute('aria-pressed', String(state.held));
  };
  const send = (message) => {
    if (state.socket?.readyState !== WebSocket.OPEN) return false;
    state.socket.send(JSON.stringify(message));
    return true;
  };
  const stopOutput = (reason) => {
    discardPcmRemainders(reason);
    const stoppedSources = state.playingSources.size;
    const queuedMilliseconds = Math.round(state.queuedOutputSeconds * 1_000);
    if (stoppedSources > 0 || queuedMilliseconds > 0) {
      diagnostic(`Audio queue cleared · ${reason} · sources=${stoppedSources} · queued_ms=${queuedMilliseconds}`);
    }
    for (const record of state.playingSources) {
      state.stoppedOutputResponses.add(record.responseId);
      try { record.source.stop(); } catch { /* already ended */ }
    }
    state.playingSources.clear();
    state.queuedOutputSeconds = 0;
    state.playHead = state.audioContext?.currentTime ?? 0;
  };
  const outputPlaybackTime = () => {
    return audioOutputTime(state.audioContext);
  };
  const stopCapture = () => {
    const capture = state.capture;
    state.capture = null;
    if (!capture) return;
    capture.node.port.onmessage = null;
    try { capture.node.disconnect(); } catch { /* already disconnected */ }
    try { capture.source.disconnect(); } catch { /* already disconnected */ }
    stopTracks(capture.stream);
  };
  const stopTracks = (stream) => {
    if (!stream || stoppedStreams.has(stream)) return;
    stoppedStreams.add(stream);
    for (const track of stream.getTracks()) { try { track.stop(); } catch { /* track already ended */ } }
  };
  const disconnectCapture = (capture) => {
    if (!capture) return;
    if (capture.node?.port) capture.node.port.onmessage = null;
    try { capture.node?.disconnect(); } catch { /* not connected */ }
    try { capture.source.disconnect(); } catch { /* not connected */ }
  };
  let loadWorklet = () => Promise.reject(new Error('Audio context is not ready'));
  const closeSession = async (message = 'Conversation ended.', reason = 'session_ended') => {
    state.sessionGeneration += 1;
    state.captureGeneration += 1;
    state.sessionStarting = false;
    const sessionId = state.sessionId;
    state.held = false;
    state.holdSource = null;
    state.waitingForCommit = false;
    state.activeResponseId = null;
    state.interruptionPending = null;
    state.commitAfterInterruption = false;
    state.cancelRequestedAt = 0;
    state.sessionReady = false;
    state.responseInProgress = false;
    stopCapture();
    stopOutput(reason);
    state.responsePlayback.reset();
    discardPcmRemainders(reason);
    state.stoppedOutputResponses.clear();
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = null;
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
    const socket = state.socket;
    state.socket = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'response.cancel' })); } catch { /* closing */ }
      }
      try { socket.close(1000, 'session ended'); } catch { /* already closed */ }
    }
    state.sessionId = null;
    state.expiresAt = 0;
    state.sessionStartedAt = 0;
    byId('session-age').textContent = 'Not started';
    byId('credential-expiry').textContent = 'Not started';
    if (sessionId) {
      try {
        await fetch(`/native/story/session/end?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
        });
      } catch { /* local server may already be closing */ }
    }
    if (state.audioContext && state.audioContext.state !== 'closed') await state.audioContext.close().catch(() => undefined);
    state.audioContext = null;
    status('session-state', message, message === 'Conversation ended.' ? '' : 'warn');
    status('turn-state', 'Microphone released.');
    status('response-state', 'Waiting for a resident session.');
    refreshControls();
  };
  const failSession = (code) => {
    const safeCode = safeProviderCode(code);
    diagnostic(`Session ended · ${safeCode}`);
    void closeSession(`Session ended · ${safeCode}`, `session_failure_${safeCode}`);
  };
  const finalizeInterruption = (responseId) => {
    const pending = state.interruptionPending;
    if (!pending || (pending.responseId && pending.responseId !== responseId)) return;
    const result = state.responsePlayback.finish(responseId);
    if (result?.truncate) send(result.truncate);
    if (pending.responseId) state.responsePlayback.clear(pending.responseId);
    state.interruptionPending = null;
    if (state.commitAfterInterruption && state.held === false && state.waitingForCommit) {
      state.commitAfterInterruption = false;
      if (!send({ type: 'input_audio_buffer.commit' })) failSession('input_commit_failed');
    }
  };
  const interruptOutput = (reason = 'held_ptt') => {
    const interruption = state.responsePlayback.interrupt(outputPlaybackTime());
    const hadUntrackedResponse = state.responseInProgress && !interruption;
    stopOutput(reason);
    if (interruption?.cancel || hadUntrackedResponse) {
      state.interruptionPending = { responseId: interruption?.responseId ?? null };
      state.cancelRequestedAt = Date.now();
      if (!send({ type: 'response.cancel' })) failSession('response_cancel_failed');
    } else if (interruption?.truncate) {
      if (!send(interruption.truncate)) failSession('response_truncate_failed');
      state.responsePlayback.clear(interruption.responseId);
    }
    if (interruption || hadUntrackedResponse) {
      state.responseInProgress = false;
      state.activeResponseId = null;
      status('response-state', 'Reply interrupted · listening.', 'good');
    }
  };
  const scheduleOutput = (encoded, event) => {
    if (!state.audioContext) return { accepted: false, reason: 'audio_context_unavailable' };
    const responseId = safeProviderId(event.response_id) ?? state.activeResponseId;
    if (!responseId || !state.responsePlayback.acceptsAudio(responseId)) return { accepted: true, ignored: true };
    const itemId = safeProviderId(event.item_id);
    const contentIndex = Number.isSafeInteger(event.content_index) && event.content_index >= 0 ? event.content_index : 0;
    const carryKey = pcmRemainderKey(responseId, itemId, contentIndex);
    const decoded = decodePcm16Base64Chunk(encoded, state.pendingPcmBytes.get(carryKey)?.byte ?? null);
    if (!decoded.valid) return {
      accepted: false, reason: 'invalid_pcm_delta', subtype: decoded.reason,
      encodedChars: decoded.encodedChars, decodedBytes: decoded.decodedBytes,
    };
    if (decoded.pendingByte === null) state.pendingPcmBytes.delete(carryKey);
    else {
      if (!state.pendingPcmBytes.has(carryKey) && state.pendingPcmBytes.size >= MAX_PENDING_PCM_REMAINDERS) {
        return { accepted: false, reason: 'pcm_fragment_state_limit', subtype: 'fragment_map_limit', encodedChars: decoded.encodedChars, decodedBytes: decoded.decodedBytes };
      }
      state.pendingPcmBytes.set(carryKey, {
      byte: decoded.pendingByte,
      responseId,
      itemId,
      contentIndex,
      encodedChars: decoded.encodedChars,
      decodedBytes: decoded.decodedBytes,
      });
    }
    const samples = decoded.samples;
    if (samples.length === 0) return { accepted: true, ignored: true, encodedChars: decoded.encodedChars, decodedBytes: decoded.decodedBytes };
    const decision = evaluateNativeAudioChunk({
      hasContext: true,
      responseAccepted: true,
      samples,
      responseSeconds: state.responseOutputSeconds,
      queuedSeconds: state.queuedOutputSeconds,
      sampleRate: RATE,
      maxResponseSeconds: MAX_OUTPUT_SECONDS_PER_RESPONSE,
      maxQueuedSeconds: MAX_QUEUED_OUTPUT_SECONDS,
    });
    if (!decision.accepted) return decision;
    const { duration } = decision;
    const buffer = state.audioContext.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(samples, 0);
    const source = state.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(state.audioContext.destination);
    const startAt = Math.max(state.playHead, state.audioContext.currentTime);
    state.playHead = startAt + duration;
    state.queuedOutputSeconds += duration;
    state.responseOutputSeconds += duration;
    state.outputSamples += samples.length;
    const record = { source, responseId };
    state.playingSources.add(record);
    state.responsePlayback.addChunk(responseId, {
      itemId,
      contentIndex,
      startAt,
      duration,
    });
    source.onended = () => {
      state.playingSources.delete(record);
      state.queuedOutputSeconds = Math.max(0, state.queuedOutputSeconds - duration);
      if (state.stoppedOutputResponses.has(responseId)) {
        if (![...state.playingSources].some((item) => item.responseId === responseId)) state.stoppedOutputResponses.delete(responseId);
        return;
      }
      if (!state.responseInProgress && ![...state.playingSources].some((item) => item.responseId === responseId) && state.sessionReady) {
        state.responsePlayback.clear(responseId);
        status('response-state', 'Reply finished · hold P to continue.', 'good');
        refreshControls();
      }
    };
    source.start(startAt);
    updateUsage();
    return { accepted: true, ignored: false };
  };
  const handleMessage = (raw) => {
    let event;
    try { event = JSON.parse(raw); } catch { diagnostic('Ignored malformed provider event.'); return; }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    if (event.type === 'session.created' || event.type === 'session.updated') {
      if (!isNativeRealtimeSessionAck(event, resident.voice)) {
        diagnostic(`${event.type} did not confirm the requested native audio settings.`);
        if (event.type === 'session.updated') failSession('session_config_mismatch');
        else status('session-state', 'Connected · waiting for the native audio configuration acknowledgement.');
        return;
      }
      if (state.ackTimer) clearTimeout(state.ackTimer);
      state.ackTimer = null;
      state.sessionReady = true;
      diagnostic(`Native audio configuration confirmed by ${event.type}.`);
      status('session-state', `${resident.name} is ready · hold P or the talk button.`, 'good');
      status('response-state', 'Persistent conversation ready.');
      refreshControls();
      return;
    }
    if (event.type === 'input_audio_buffer.committed' && state.waitingForCommit) {
      state.waitingForCommit = false;
      if (!send({ type: 'response.create' })) { failSession('response_create_failed'); return; }
      state.responseInProgress = true;
      state.responseOutputSeconds = 0;
      status('response-state', `${resident.name} is listening to the released turn.`, 'good');
      refreshControls();
      return;
    }
    if (event.type === 'response.created') {
      const responseId = safeProviderId(event.response?.id ?? event.response_id);
      if (!responseId || !state.responsePlayback.begin(responseId)) return;
      state.activeResponseId = responseId;
      state.responseInProgress = true;
      status('response-state', `${resident.name} is replying in native audio.`, 'good');
      refreshControls();
      return;
    }
    if (event.type === 'response.output_audio.delta') {
      const scheduled = scheduleOutput(event.delta, event);
      if (!scheduled.accepted) {
        const responseId = safeProviderId(event.response_id) ?? state.activeResponseId ?? 'unknown';
        const itemId = safeProviderId(event.item_id) ?? 'unknown';
        diagnostic(`Audio output rejected · ${scheduled.reason} · response=${responseId} · item=${itemId}`
          + ` · encoded_chars=${Number.isSafeInteger(scheduled.encodedChars) ? scheduled.encodedChars : 0}`
          + ` · decoded_bytes=${Number.isSafeInteger(scheduled.decodedBytes) ? scheduled.decodedBytes : 'unknown'}`
          + ` · reject=${scheduled.subtype ?? 'audio_limit'}`
          + ` · queued_ms=${Math.round(state.queuedOutputSeconds * 1_000)}`);
        interruptOutput(`output_rejected_${scheduled.reason}`);
        status('response-state', `Response stopped · ${scheduled.reason.replaceAll('_', ' ')}.`, 'warn');
        refreshControls();
      }
      return;
    }
    if (event.type === 'response.output_audio_transcript.delta' && typeof event.delta === 'string'
      && event.delta.length > 0 && event.delta.length <= 2_048) {
      const responseId = safeProviderId(event.response_id) ?? state.activeResponseId;
      if (!responseId || !state.responsePlayback.acceptsAudio(responseId)) return;
      window.dispatchEvent(new CustomEvent('native-ptt-transcript-delta', {
        detail: { speakerId: 'mira', responseId, itemId: safeProviderId(event.item_id), delta: event.delta },
      }));
      return;
    }
    if (event.type === 'response.done') {
      const responseId = safeProviderId(event.response?.id ?? event.response_id)
        ?? state.interruptionPending?.responseId ?? state.activeResponseId;
      const interruptedCompletion = Boolean(state.interruptionPending);
      if (responseId) {
        discardPcmRemainders('response_finished', responseId);
        if (state.interruptionPending) finalizeInterruption(responseId);
        else state.responsePlayback.finish(responseId);
        if (state.activeResponseId === responseId) state.activeResponseId = null;
      }
      state.responseInProgress = false;
      state.turns += 1;
      const response = event.response && typeof event.response === 'object' ? event.response : {};
      const responseStatus = ['completed', 'cancelled', 'incomplete', 'failed'].includes(response.status) ? response.status : 'unknown';
      if (responseStatus !== 'completed') {
        diagnostic(`Response ended · status=${responseStatus} · response=${responseId ?? 'unknown'} · queued_ms=${Math.round(state.queuedOutputSeconds * 1_000)}`);
      }
      const responseTokens = summarizeRealtimeAudioUsage(response.usage);
      if (responseTokens) {
        state.providerTokens = Object.fromEntries(Object.keys(responseTokens).map((field) => [
          field,
          responseTokens[field] === null ? state.providerTokens?.[field] ?? null
            : (state.providerTokens?.[field] ?? 0) + responseTokens[field],
        ]));
        diagnostic('Provider usage counters received; no response text retained.');
      }
      updateUsage();
      if (responseId && ![...state.playingSources].some((item) => item.responseId === responseId)) {
        state.responsePlayback.clear(responseId);
      }
      if (!state.held) status('turn-state', 'Microphone released.', 'good');
      if (interruptedCompletion) {
        status('response-state', state.held ? 'Reply interrupted · listening.' : 'Reply interrupted · hold P to talk.', 'good');
      } else {
        status('response-state', state.playingSources.size
          ? `${resident.name} finished speaking generation · playing audio.`
          : response.status === 'completed' ? 'Reply complete · hold P to continue.' : 'Turn ended without a completed reply.',
        response.status === 'completed' ? 'good' : 'warn');
      }
      refreshControls();
      return;
    }
    if (event.type === 'error') {
      if (safeProviderCode(event.error?.code) === 'response_cancel_not_active'
        && state.cancelRequestedAt > 0 && Date.now() - state.cancelRequestedAt <= 5_000) {
        if (state.interruptionPending) finalizeInterruption(state.interruptionPending.responseId);
        state.cancelRequestedAt = 0;
        return;
      }
      failSession(event.error?.code);
    }
  };

  const startSession = async () => {
    if (state.sessionStarting || state.sessionId) return;
    const generation = ++state.sessionGeneration;
    state.sessionStarting = true;
    refreshControls();
    status('session-state', 'Starting native Realtime session…');
    try {
      state.audioContext = new AudioContext({ sampleRate: RATE });
      const audioContext = state.audioContext;
      loadWorklet = createRetryableWorkletLoader(() => audioContext.audioWorklet.addModule('/boson-ptt-worklet.js'));
      await audioContext.resume();
      const response = await fetch('/native/story/session/start', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ residentId: resident.residentId }),
      });
      const setup = await response.json().catch(() => ({}));
      if (!response.ok || setup.available !== true || typeof setup.instructions !== 'string' || typeof setup.residentSessionId !== 'string' || typeof setup.clientSecret !== 'string'
        || !setup.clientSecret.startsWith('bai-eph-') || typeof setup.sessionId !== 'string'
        || !Number.isSafeInteger(setup.expiresAt)) {
        throw new Error(typeof setup.error === 'string' ? setup.error : 'Native Realtime session unavailable.');
      }
      if (generation !== state.sessionGeneration || !state.sessionStarting) {
        void fetch(`/native/story/session/end?sessionId=${encodeURIComponent(setup.sessionId)}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
        return;
      }
      state.sessionId = setup.sessionId;
      state.expiresAt = setup.expiresAt;
      state.sessionStartedAt = Date.now();
      state.heartbeatTimer = window.setInterval(async () => {
        if (!state.sessionId) return;
        try {
          const heartbeat = await fetch(`/native/story/session/heartbeat?sessionId=${encodeURIComponent(state.sessionId)}`, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
          });
          if (heartbeat.status === 404) failSession('local_session_lease_expired');
        } catch { /* retry next interval; the lease tolerates short local interruptions */ }
      }, 20_000);
      const secret = setup.clientSecret;
      setup.clientSecret = '';
      const socket = new WebSocket(REALTIME_URL, ['realtime', `bai-client-secret.${secret}`]);
      state.socket = socket;
      state.ackTimer = setTimeout(() => failSession('session_ack_timeout'), 15_000);
      socket.addEventListener('open', () => {
        if (state.socket !== socket) return;
        const session = {
          model: 'higgs-realtime',
          instructions: setup.instructions,
          output_modalities: ['audio'],
          audio: {
            input: { format: { type: 'audio/pcm', rate: RATE }, noise_reduction: { type: 'near_field' }, turn_detection: null },
            output: { format: { type: 'audio/pcm', rate: RATE }, voice: resident.voice },
          },
          tools: [],
          tool_choice: 'none',
        };
        socket.send(JSON.stringify({ type: 'session.update', session }));
        byId('session-state').textContent = 'Realtime connected · waiting for configuration acknowledgement.';
      });
      socket.addEventListener('message', (event) => {
        if (state.socket === socket && typeof event.data === 'string') handleMessage(event.data);
      });
      socket.addEventListener('error', () => failSession('websocket_error'));
      socket.addEventListener('close', () => {
        if (state.socket === socket) failSession('websocket_closed');
      });
      state.sessionStarting = false;
      refreshControls();
      updateUsage();
    } catch (error) {
      if (generation !== state.sessionGeneration) return;
      const safeText = error instanceof Error && error.message === 'Native Realtime session unavailable.'
        ? error.message : 'Native Realtime session could not start. Check local status and the provider safe error below.';
      state.sessionStarting = false;
      await closeSession(safeText);
      diagnostic('Session start failed · check provider availability or safe status.');
    }
  };

  const startCapture = async () => {
    if (!state.sessionReady || state.held || state.waitingForCommit) return;
    const captureGeneration = ++state.captureGeneration;
    const isCurrent = () => state.captureGeneration === captureGeneration && state.held && state.sessionReady;
    state.held = true;
    interruptOutput();
    if (!state.held || !state.sessionReady) return;
    status('turn-state', 'Microphone permission requested for this held turn…');
    refreshControls();
    const result = await acquireNativeCapture({
      isCurrent,
      getUserMedia: () => {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'NotSupportedError' });
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      },
      resumeContext: () => state.audioContext.resume(),
      prepareWorklet: loadWorklet,
      createCapture: (stream) => {
        const source = state.audioContext.createMediaStreamSource(stream);
        let node;
        try {
          node = new AudioWorkletNode(state.audioContext, 'boson-ptt-capture', {
            processorOptions: { targetSampleRate: RATE },
          });
          node.port.onmessage = (event) => {
            const samples = event.data;
            if (!isCurrent() || !(samples instanceof Float32Array) || samples.length === 0) return;
            const audio = encodePcm16(samples);
            if (state.socket?.readyState === WebSocket.OPEN) {
              state.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
              state.inputSamples += samples.length;
              updateUsage();
            }
          };
          source.connect(node);
          node.connect(state.audioContext.destination);
          return { stream, source, node };
        } catch (error) {
          disconnectCapture({ source, node });
          throw error;
        }
      },
      stopStream: stopTracks,
      disconnectCapture,
    });
    if (!isCurrent()) return;
    if (!result.capture) {
      state.held = false;
      state.holdSource = null;
      status('turn-state', `Microphone unavailable · ${result.reason.replaceAll('_', ' ')}.`, 'warn');
      refreshControls();
      return;
    }
    state.capture = result.capture;
    status('turn-state', 'Listening · release P to send this turn.', 'good');
    refreshControls();
  };
  const releaseCapture = () => {
    if (!state.held) return;
    state.captureGeneration += 1;
    state.held = false;
    state.holdSource = null;
    const hadCapture = Boolean(state.capture);
    stopCapture();
    refreshControls();
    if (!hadCapture || state.socket?.readyState !== WebSocket.OPEN) {
      status('turn-state', 'Microphone released · no audio turn was sent.');
      return;
    }
    state.waitingForCommit = true;
    status('turn-state', 'Microphone released · finishing this turn…', 'good');
    if (state.interruptionPending) {
      state.commitAfterInterruption = true;
      return;
    }
    if (!send({ type: 'input_audio_buffer.commit' })) {
      state.waitingForCommit = false;
      failSession('input_commit_failed');
    }
  };

  startButton.addEventListener('click', () => { void startSession(); });
  endButton.addEventListener('click', () => { void closeSession(); });
  talkButton.addEventListener('pointerdown', (event) => {
    if (talkButton.disabled || state.held) return;
    event.preventDefault();
    try { talkButton.setPointerCapture(event.pointerId); } catch { /* optional */ }
    state.holdSource = 'pointer';
    void startCapture();
  });
  window.addEventListener('pointerup', (event) => {
    if (state.holdSource === 'pointer') { event.preventDefault(); releaseCapture(); }
  }, true);
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const editable = target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)
      || Boolean(target?.closest?.('[contenteditable=""], [contenteditable="true"], [role="textbox"]'));
    if (root.hidden || event.code !== 'KeyP' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
      || event.shiftKey || editable || talkButton.disabled || state.held) return;
    event.preventDefault();
    state.holdSource = 'key';
    void startCapture();
  });
  document.addEventListener('keyup', (event) => {
    if (event.code === 'KeyP' && state.holdSource === 'key') { event.preventDefault(); releaseCapture(); }
  });
  window.addEventListener('blur', releaseCapture);
  root.addEventListener('resident-deactivate', releaseCapture);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') releaseCapture(); });
  const usageTimer = window.setInterval(updateUsage, 1_000);
  window.addEventListener('pagehide', () => {
    window.clearInterval(usageTimer);
    void closeSession('Page closed · session ended.');
  }, { once: true });
  byId('voice-name').textContent = resident.voice;
  refreshControls();
}

async function bootStoryTester() {
  const selector = document.getElementById('resident-select');
  const controllerHost = document.getElementById('resident-controllers');
  const template = document.getElementById('resident-template');
  const response = await fetch('/native/story/residents', { credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.residents)) throw new Error('Resident list unavailable.');
  const roots = new Map();
  selector.replaceChildren();
  for (const resident of data.residents) {
    const option = document.createElement('option'); option.value = resident.residentId; option.textContent = `${resident.name} · ${resident.role}`; selector.append(option);
    const fragment = template.content.cloneNode(true);
    const root = fragment.querySelector('.resident-panel');
    controllerHost.append(root); roots.set(resident.residentId, { root, resident });
    bootNativePtt(root, resident);
  }
  const select = () => { for (const [id, nodes] of roots) { const hidden = id !== selector.value; nodes.root.hidden = hidden; if (hidden) nodes.root.dispatchEvent(new Event('resident-deactivate')); } };
  selector.addEventListener('change', select); select();
  document.getElementById('end-sessions').addEventListener('click', () => { for (const { root } of roots.values()) root.querySelector('#end-session').click(); });
}

if (typeof document !== 'undefined') {
  document.getElementById('end-sessions').disabled = false;
  bootStoryTester().catch(() => { document.getElementById('resident-role').textContent = 'Resident list unavailable. Restart the local tester.'; });
}
