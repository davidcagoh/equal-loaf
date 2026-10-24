const RATE = 24_000;
const REALTIME_URL = 'wss://api.boson.ai/v1/realtime';
const MAX_DELTA_BASE64_CHARS = 256_000;
const MAX_QUEUED_OUTPUT_SECONDS = 60;
const MAX_OUTPUT_SECONDS_PER_RESPONSE = 120;
const VALID_PROVIDER_CODES = new Set([
  'invalid_request_error', 'authentication_error', 'rate_limit_exceeded', 'server_error',
  'session_expired', 'response_cancel_not_active', 'input_audio_buffer_commit_empty',
]);

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

export function isNativeRealtimeSessionAck(event) {
  if (!event || typeof event !== 'object' || !['session.created', 'session.updated'].includes(event.type)) return false;
  const session = event.session;
  const input = session?.audio?.input;
  const output = session?.audio?.output;
  const modalities = session?.output_modalities;
  return Array.isArray(modalities) && modalities.length === 1 && modalities[0] === 'audio'
    && input?.format?.type === 'audio/pcm' && input.format.rate === RATE && input.turn_detection === null
    && output?.format?.type === 'audio/pcm' && output.format.rate === RATE && output.voice === 'chloe'
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

function bootNativePtt() {
  const byId = (id) => document.getElementById(id);
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
    inputSamples: 0,
    outputSamples: 0,
    turns: 0,
    sessionStartedAt: 0,
    playHead: 0,
    queuedOutputSeconds: 0,
    responseOutputSeconds: 0,
    playingSources: new Set(),
    providerTokens: null,
    timers: new Set(),
    workletReady: null,
    ackTimer: null,
    sessionGeneration: 0,
    heartbeatTimer: null,
  };

  const diagnostic = (message) => {
    const list = byId('diagnostic-list');
    const item = document.createElement('li');
    item.textContent = message;
    list.append(item);
    while (list.children.length > 12) list.firstElementChild.remove();
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
    talkButton.disabled = !state.sessionReady || state.waitingForCommit || state.responseInProgress
      || (state.playingSources.size > 0 && !state.held);
    talkButton.textContent = state.held ? 'Release to send' : 'Hold P to talk';
    talkButton.setAttribute('aria-pressed', String(state.held));
  };
  const send = (message) => {
    if (state.socket?.readyState !== WebSocket.OPEN) return false;
    state.socket.send(JSON.stringify(message));
    return true;
  };
  const stopOutput = () => {
    for (const source of state.playingSources) {
      try { source.stop(); } catch { /* already ended */ }
    }
    state.playingSources.clear();
    state.queuedOutputSeconds = 0;
    state.playHead = state.audioContext?.currentTime ?? 0;
  };
  const stopCapture = () => {
    const capture = state.capture;
    state.capture = null;
    if (!capture) return;
    capture.node.port.onmessage = null;
    try { capture.node.disconnect(); } catch { /* already disconnected */ }
    try { capture.source.disconnect(); } catch { /* already disconnected */ }
    for (const track of capture.stream.getTracks()) track.stop();
  };
  const closeSession = async (message = 'Conversation ended.') => {
    state.sessionGeneration += 1;
    state.sessionStarting = false;
    const sessionId = state.sessionId;
    state.held = false;
    state.holdSource = null;
    state.waitingForCommit = false;
    state.sessionReady = false;
    state.responseInProgress = false;
    stopCapture();
    stopOutput();
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
        await fetch(`/native/session/end?sessionId=${encodeURIComponent(sessionId)}`, {
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
    void closeSession(`Session ended · ${safeCode}`);
  };
  const scheduleOutput = (encoded) => {
    if (!state.audioContext) return false;
    const samples = decodePcm16Base64Audio(encoded);
    if (!samples) return false;
    const duration = samples.length / RATE;
    if (state.responseOutputSeconds + duration > MAX_OUTPUT_SECONDS_PER_RESPONSE
      || state.queuedOutputSeconds + duration > MAX_QUEUED_OUTPUT_SECONDS) return false;
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
    state.playingSources.add(source);
    source.onended = () => {
      state.playingSources.delete(source);
      state.queuedOutputSeconds = Math.max(0, state.queuedOutputSeconds - duration);
      if (!state.responseInProgress && state.playingSources.size === 0 && state.sessionReady) {
        status('response-state', 'Reply finished · hold P to continue.', 'good');
        refreshControls();
      }
    };
    source.start(startAt);
    updateUsage();
    return true;
  };
  const handleMessage = (raw) => {
    let event;
    try { event = JSON.parse(raw); } catch { diagnostic('Ignored malformed provider event.'); return; }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    if (event.type === 'session.created' || event.type === 'session.updated') {
      if (!isNativeRealtimeSessionAck(event)) {
        diagnostic(`${event.type} did not confirm the requested native audio settings.`);
        if (event.type === 'session.updated') failSession('session_config_mismatch');
        else status('session-state', 'Connected · waiting for the native audio configuration acknowledgement.');
        return;
      }
      if (state.ackTimer) clearTimeout(state.ackTimer);
      state.ackTimer = null;
      state.sessionReady = true;
      diagnostic(`Native audio configuration confirmed by ${event.type}.`);
      status('session-state', 'Anna is ready · hold P or the talk button.', 'good');
      status('response-state', 'Persistent conversation ready.');
      refreshControls();
      return;
    }
    if (event.type === 'input_audio_buffer.committed' && state.waitingForCommit) {
      state.waitingForCommit = false;
      if (!send({ type: 'response.create' })) { failSession('response_create_failed'); return; }
      state.responseInProgress = true;
      state.responseOutputSeconds = 0;
      status('response-state', 'Anna is listening to the released turn.', 'good');
      refreshControls();
      return;
    }
    if (event.type === 'response.created') {
      state.responseInProgress = true;
      status('response-state', 'Anna is replying in native audio.', 'good');
      refreshControls();
      return;
    }
    if (event.type === 'response.output_audio.delta') {
      if (!scheduleOutput(event.delta)) {
        diagnostic('Audio response stopped at the local output buffer limit.');
        send({ type: 'response.cancel' });
        stopOutput();
        state.responseInProgress = false;
        status('response-state', 'Response stopped · audio buffer limit reached.', 'warn');
        refreshControls();
      }
      return;
    }
    if (event.type === 'response.output_audio_transcript.delta' && typeof event.delta === 'string'
      && event.delta.length > 0 && event.delta.length <= 2_048) {
      const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value) ? value : null;
      window.dispatchEvent(new CustomEvent('native-ptt-transcript-delta', {
        detail: { speakerId: 'mira', responseId: safeId(event.response_id), itemId: safeId(event.item_id), delta: event.delta },
      }));
      return;
    }
    if (event.type === 'response.done') {
      state.responseInProgress = false;
      state.waitingForCommit = false;
      state.turns += 1;
      const response = event.response && typeof event.response === 'object' ? event.response : {};
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
      status('turn-state', 'Microphone released.', 'good');
      status('response-state', state.playingSources.size
        ? 'Anna finished speaking generation · playing audio.'
        : response.status === 'completed' ? 'Reply complete · hold P to continue.' : 'Turn ended without a completed reply.',
      response.status === 'completed' ? 'good' : 'warn');
      refreshControls();
      return;
    }
    if (event.type === 'error') {
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
      await state.audioContext.resume();
      const response = await fetch('/native/session/start', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      });
      const setup = await response.json().catch(() => ({}));
      if (!response.ok || setup.available !== true || typeof setup.clientSecret !== 'string'
        || !setup.clientSecret.startsWith('bai-eph-') || typeof setup.sessionId !== 'string'
        || !Number.isSafeInteger(setup.expiresAt)) {
        throw new Error(typeof setup.error === 'string' ? setup.error : 'Native Realtime session unavailable.');
      }
      if (generation !== state.sessionGeneration || !state.sessionStarting) {
        void fetch(`/native/session/end?sessionId=${encodeURIComponent(setup.sessionId)}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
        return;
      }
      state.sessionId = setup.sessionId;
      state.expiresAt = setup.expiresAt;
      state.sessionStartedAt = Date.now();
      state.heartbeatTimer = window.setInterval(async () => {
        if (!state.sessionId) return;
        try {
          const heartbeat = await fetch(`/native/session/heartbeat?sessionId=${encodeURIComponent(state.sessionId)}`, {
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
          instructions: [
            'You are Anna, a warm and practical garden helper in a small Minecraft village.',
            'Keep a natural, friendly spoken conversation and remember what was said earlier in this same conversation.',
            'You may discuss these public village facts: the garden is growing well today; the east beds need watering.',
            'You may remember the player’s name, preferences, and earlier exchanges from this conversation, but do not present those as new world facts.',
            'If asked about other village facts, say plainly that you do not know. Never invent events, secrets, clues, or resident knowledge.',
            'This isolated voice lab has no game tools. Do not claim to change blocks, inventory, world state, or resident cognition.',
            'Keep each spoken reply concise and easy to hear.',
          ].join(' '),
          output_modalities: ['audio'],
          audio: {
            input: { format: { type: 'audio/pcm', rate: RATE }, noise_reduction: { type: 'near_field' }, turn_detection: null },
            output: { format: { type: 'audio/pcm', rate: RATE }, voice: 'chloe' },
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
    if (!state.sessionReady || state.held || state.responseInProgress || state.playingSources.size) return;
    state.held = true;
    status('turn-state', 'Microphone permission requested for this held turn…');
    refreshControls();
    let stream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('permission_unavailable');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      if (!state.held || !state.sessionReady) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (!state.workletReady) state.workletReady = state.audioContext.audioWorklet.addModule('/boson-ptt-worklet.js');
      await state.workletReady;
      if (!state.held || !state.sessionReady) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const source = state.audioContext.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(state.audioContext, 'boson-ptt-capture', {
        processorOptions: { targetSampleRate: RATE },
      });
      node.port.onmessage = (event) => {
        const samples = event.data;
        if (!state.held || !state.sessionReady || !(samples instanceof Float32Array) || samples.length === 0) return;
        const audio = encodePcm16(samples);
        if (state.socket?.readyState === WebSocket.OPEN) {
          state.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
          state.inputSamples += samples.length;
          updateUsage();
        }
      };
      source.connect(node);
      node.connect(state.audioContext.destination);
      state.capture = { stream, source, node };
      status('turn-state', 'Listening · release P to send this turn.', 'good');
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      state.held = false;
      state.holdSource = null;
      status('turn-state', 'Microphone unavailable · check this page’s permission and input device.', 'warn');
    }
    refreshControls();
  };
  const releaseCapture = () => {
    if (!state.held) return;
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
    if (event.code !== 'KeyP' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
      || event.shiftKey || editable || talkButton.disabled || state.held) return;
    event.preventDefault();
    state.holdSource = 'key';
    void startCapture();
  });
  document.addEventListener('keyup', (event) => {
    if (event.code === 'KeyP' && state.holdSource === 'key') { event.preventDefault(); releaseCapture(); }
  });
  window.addEventListener('blur', releaseCapture);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') releaseCapture(); });
  const usageTimer = window.setInterval(updateUsage, 1_000);
  window.addEventListener('pagehide', () => {
    window.clearInterval(usageTimer);
    void closeSession('Page closed · session ended.');
  }, { once: true });
  refreshControls();
}

if (typeof document !== 'undefined') bootNativePtt();
