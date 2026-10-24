import { PLAYER_INTENTS, VILLAGE_TOPICS } from './village-vocabulary.js';

const MAX_HOLD_MS = 30_000;
const MAX_TOTAL_INPUT_MS = 300_000;
const TARGET_SAMPLE_RATE = 24_000;
const AUDIO_CHUNK_SAMPLES = 960;
const REALTIME_URL = 'wss://api.boson.ai/v1/realtime';
const stoppedStreams = new WeakSet();
const MAX_MODEL_OUTPUT_BYTES = 2_000;

export function appendBoundedPttText(currentText, delta, alreadyRejected = false) {
  if (alreadyRejected || typeof currentText !== 'string' || typeof delta !== 'string'
    || currentText.length + delta.length > MAX_MODEL_OUTPUT_BYTES) return { text: '', rejected: true };
  const text = currentText + delta;
  return new TextEncoder().encode(text).byteLength > MAX_MODEL_OUTPUT_BYTES
    ? { text: '', rejected: true }
    : { text, rejected: false };
}

export function recordSingleTerminalPttText(currentCount, text) {
  if (typeof text !== 'string') return { text: null, count: 0, rejectionReason: 'response_text_missing' };
  if (currentCount > 0) return { text: null, count: currentCount + 1, rejectionReason: 'response_text_multiple_parts' };
  if (text.length > MAX_MODEL_OUTPUT_BYTES || new TextEncoder().encode(text).byteLength > MAX_MODEL_OUTPUT_BYTES) {
    return { text: null, count: 1, rejectionReason: 'response_text_too_large' };
  }
  return { text, count: 1, rejectionReason: null };
}

export function isBoundedPttResponse(value, allowedLineIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  return keys === 'lineId,playerIntent,topic'
    && typeof value.playerIntent === 'string'
    && PLAYER_INTENTS.includes(value.playerIntent)
    && typeof value.topic === 'string' && VILLAGE_TOPICS.includes(value.topic)
    && /^[A-Za-z0-9 _-]+$/.test(value.topic)
    && typeof value.lineId === 'string' && allowedLineIds.includes(value.lineId);
}

export function isBoundedPttLineIdList(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every((id) => typeof id === 'string' && /^[A-Za-z0-9:._-]{1,128}$/.test(id))
    && new Set(value).size === value.length;
}

export function evaluateCompletedPttResponse(event, accumulatedText, terminalText, allowedLineIds, terminalPartCount = Number(typeof terminalText === 'string')) {
  if (!event || typeof event !== 'object' || event.type !== 'response.done'
    || !event.response || typeof event.response !== 'object' || event.response.status !== 'completed') {
    return { response: null, rejectionReason: 'response_status_not_completed' };
  }

  let text;
  if (Array.isArray(event.response.output)) {
    if (event.response.output.length > 32) return { response: null, rejectionReason: 'response_output_too_large' };
    let textPartCount = 0;
    for (const item of event.response.output) {
      if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) continue;
      if (item.content.length > 32) return { response: null, rejectionReason: 'response_output_too_large' };
      for (const part of item.content) {
        if (part?.type !== 'output_text' || typeof part.text !== 'string') continue;
        textPartCount += 1;
        if (textPartCount > 1) return { response: null, rejectionReason: 'response_text_multiple_parts' };
        if (part.text.length > MAX_MODEL_OUTPUT_BYTES) return { response: null, rejectionReason: 'response_text_too_large' };
        text = part.text;
      }
    }
    if (textPartCount !== 1) return {
      response: null,
      rejectionReason: 'response_text_missing',
    };
  } else if (terminalPartCount > 1) {
    return { response: null, rejectionReason: 'response_text_multiple_parts' };
  } else if (typeof terminalText === 'string') {
    text = terminalText;
  } else if (typeof accumulatedText === 'string') {
    text = accumulatedText;
  } else {
    return { response: null, rejectionReason: 'response_text_missing' };
  }
  if (!text) return { response: null, rejectionReason: 'response_text_missing' };
  if (text.length > MAX_MODEL_OUTPUT_BYTES || new TextEncoder().encode(text).byteLength > MAX_MODEL_OUTPUT_BYTES) {
    return { response: null, rejectionReason: 'response_text_too_large' };
  }
  try {
    const value = JSON.parse(text);
    return isBoundedPttResponse(value, allowedLineIds)
      ? { response: value, rejectionReason: null }
      : { response: null, rejectionReason: 'response_schema_rejected' };
  } catch {
    return { response: null, rejectionReason: 'response_json_invalid' };
  }
}

export function parseCompletedPttResponse(event, accumulatedText, terminalText, allowedLineIds) {
  return evaluateCompletedPttResponse(event, accumulatedText, terminalText, allowedLineIds).response;
}

export function startViewerPtt() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = `
    #boson-ptt { position: fixed; z-index: 6; left: 16px; top: 16px; width: min(320px, calc(100vw - 32px));
      box-sizing: border-box; padding: 12px; color: #f8fafc; background: rgba(15,23,42,.94);
      border: 1px solid rgba(148,163,184,.45); border-radius: 10px; font: 14px/1.4 system-ui,sans-serif; }
    #boson-ptt strong { display:block; margin-bottom: 6px; }
    #boson-ptt button { min-height: 42px; padding: 8px 14px; color: #f8fafc; background:#7c2d12;
      border:1px solid #fdba74; border-radius:6px; font:600 15px/1.2 system-ui,sans-serif; cursor:pointer; touch-action:none; }
    #boson-ptt button:focus-visible { outline: 3px solid #fbbf24; outline-offset: 2px; }
    #boson-ptt button:disabled { cursor:not-allowed; opacity:.65; }
    #boson-ptt-status { display:block; margin-top:8px; color:#cbd5e1; }
  `;
  document.head.append(style);
  const panel = document.createElement('section');
  panel.id = 'boson-ptt';
  panel.setAttribute('aria-label', 'Push-to-talk village conversation');
  const title = document.createElement('strong');
  title.textContent = 'Talk to a nearby villager';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Hold P to talk';
  button.setAttribute('aria-label', 'Hold P to talk, or hold this button; release to send');
  button.setAttribute('aria-pressed', 'false');
  const status = document.createElement('span');
  status.id = 'boson-ptt-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Checking local voice availability…';
  panel.append(title, button, status);
  document.body.append(panel);

  let available = false;
  let held = false;
  let currentTurn = null;
  let holdTimer = null;
  let turnsUsed = 0;
  let totalInputMs = 0;
  let generation = 0;
  let holdSource = null;

  const stopTracks = (stream) => {
    if (!stream || typeof stream !== 'object' || stoppedStreams.has(stream)) return;
    stoppedStreams.add(stream);
    for (const track of stream?.getTracks?.() ?? []) track.stop();
  };
  const setStatus = (message) => { status.textContent = message; };
  const resetHoldControl = () => {
    if (holdTimer) window.clearTimeout(holdTimer);
    holdTimer = null;
    held = false;
    holdSource = null;
    button.setAttribute('aria-pressed', 'false');
    button.textContent = 'Hold P to talk';
  };
  const closeSocket = (socket) => {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Push-to-talk turn ended');
  };

  async function post(path, payload) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async function cancelTurn(active) {
    if (!active?.turnId || active.cancelSent) return;
    active.cancelSent = true;
    try { await post('/boson-ptt/cancel', { turnId: active.turnId }); } catch { /* turn expiry is the server fallback */ }
  }

  function clearAudio(active) {
    active.worklet?.port && (active.worklet.port.onmessage = null);
    for (const node of [active.source, active.worklet, active.silence]) {
      try { node?.disconnect(); } catch { /* already disconnected */ }
    }
    stopTracks(active.stream);
    if (active.audioContext && active.audioContext.state !== 'closed') void active.audioContext.close().catch(() => undefined);
    active.pendingSamples = [];
  }

  function sendPcmChunk(active, samples) {
    if (active.phase !== 'capturing' || !held || active.socket?.readyState !== WebSocket.OPEN || samples.length === 0) return false;
    const pcm = new Uint8Array(samples.length * 2);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    let binary = '';
    for (const byte of pcm) binary += String.fromCharCode(byte);
    active.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(binary) }));
    active.samplesSent += samples.length;
    totalInputMs += (samples.length / TARGET_SAMPLE_RATE) * 1_000;
    return true;
  }

  function startAudioCapture(active) {
    if (currentTurn !== active || !held || active.releaseRequested) {
      clearAudio(active);
      void cancelTurn(active);
      return;
    }
    try {
      active.audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      active.source = active.audioContext.createMediaStreamSource(active.stream);
      active.workletPromise = active.audioContext.audioWorklet.addModule('/boson-ptt-worklet.js');
      void active.workletPromise.then(() => {
        if (currentTurn !== active || !held || active.releaseRequested || active.socket?.readyState !== WebSocket.OPEN) {
          clearAudio(active);
          void cancelTurn(active);
          return;
        }
        active.worklet = new AudioWorkletNode(active.audioContext, 'boson-ptt-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
        });
        active.silence = active.audioContext.createGain();
        active.silence.gain.value = 0;
        active.pendingSamples = [];
        active.worklet.port.onmessage = (event) => {
          if (currentTurn !== active || active.phase !== 'capturing' || !held || !(event.data instanceof Float32Array)) return;
          for (const sample of event.data) active.pendingSamples.push(sample);
          while (active.pendingSamples.length >= AUDIO_CHUNK_SAMPLES) {
            const chunk = active.pendingSamples.splice(0, AUDIO_CHUNK_SAMPLES);
            if (!sendPcmChunk(active, chunk)) break;
            if (totalInputMs >= MAX_TOTAL_INPUT_MS) {
              finishHold(true);
              break;
            }
          }
        };
        active.source.connect(active.worklet);
        active.worklet.connect(active.silence);
        active.silence.connect(active.audioContext.destination);
        active.phase = 'capturing';
        setStatus('Listening only while held. Release to send this turn.');
      }).catch(() => failTurn(active, 'Local audio capture is unavailable; village voices remain available.'));
    } catch {
      failTurn(active, 'Local audio capture is unavailable; village voices remain available.');
    }
  }

  async function completeTurn(active, modelResponse) {
    if (active.completionSent || !active.turnId) return;
    active.completionSent = true;
    try {
      const response = await post('/boson-ptt/complete', { turnId: active.turnId, response: modelResponse });
      const result = await response.json().catch(() => ({}));
      setStatus(response.ok && result.status === 'accepted' ? 'A nearby villager selected an authored response.'
        : response.ok && result.status === 'fallback' ? 'The fixed authored fallback was used; semantic intent was not confirmed.'
          : 'The turn ended; local village dialogue remains available.');
    } catch {
      setStatus('The turn ended; local village dialogue remains available.');
    }
    closeSocket(active.socket);
    clearAudio(active);
    if (currentTurn === active) currentTurn = null;
  }

  async function failTurn(active, message) {
    if (currentTurn !== active) return;
    clearAudio(active);
    closeSocket(active.socket);
    if (active.samplesSent > 0 && active.turnId) await completeTurn(active, null);
    else await cancelTurn(active);
    if (currentTurn === active) currentTurn = null;
    setStatus(message);
  }

  function rejectModelOutput(active, reason) {
    active.responseOutputRejected = true;
    active.responseText = '';
    active.terminalResponseText = null;
    active.terminalResponseCount = 0;
    window.dispatchEvent(new CustomEvent('ptt-response-rejected', { detail: { reason } }));
    void completeTurn(active, null);
  }

  function validLineIds(value) {
    return isBoundedPttLineIdList(value);
  }

  function handleProviderMessage(active, raw) {
    if (active.completionSent) return;
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    if (event.type === 'session.created') {
      active.sessionReady = true;
      startAudioCapture(active);
      return;
    }
    if (event.type === 'input_audio_buffer.committed') {
      active.socket.send(JSON.stringify({ type: 'response.create', response: { max_output_tokens: 160 } }));
      return;
    }
    if (event.type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') return;
      const appended = appendBoundedPttText(active.responseText, event.delta, active.responseOutputRejected);
      if (appended.rejected) {
        active.socket.send(JSON.stringify({ type: 'response.cancel' }));
        rejectModelOutput(active, 'response_text_too_large');
        return;
      }
      active.responseText = appended.text;
      return;
    }
    if (event.type === 'response.output_text.done') {
      if (active.responseOutputRejected) return;
      const terminalText = recordSingleTerminalPttText(active.terminalResponseCount, event.text);
      active.terminalResponseCount = terminalText.count;
      if (terminalText.rejectionReason) {
        active.socket.send(JSON.stringify({ type: 'response.cancel' }));
        rejectModelOutput(active, terminalText.rejectionReason);
        return;
      }
      active.terminalResponseText = terminalText.text;
      return;
    }
    if (event.type === 'response.done') {
      const { response, rejectionReason } = active.responseOutputRejected
        ? { response: null, rejectionReason: 'response_text_too_large' }
        : evaluateCompletedPttResponse(
          event, active.responseText, active.terminalResponseText, active.allowedLineIds, active.terminalResponseCount,
        );
      active.responseText = '';
      active.terminalResponseText = null;
      active.terminalResponseCount = 0;
      if (rejectionReason) window.dispatchEvent(new CustomEvent('ptt-response-rejected', { detail: { reason: rejectionReason } }));
      void completeTurn(active, response);
      return;
    }
    if (event.type === 'error') {
      void failTurn(active, 'Boson voice could not finish; local village dialogue remains available.');
    }
  }

  async function connectProvider(active, setup) {
    if (!held || active.releaseRequested || currentTurn !== active) {
      await cancelTurn(active);
      stopTracks(active.stream);
      if (currentTurn === active) currentTurn = null;
      return;
    }
    active.turnId = setup.turnId;
    active.allowedLineIds = setup.allowedLineIds;
    active.socket = new WebSocket(REALTIME_URL, ['realtime', `bai-client-secret.${setup.clientSecret}`]);
    active.phase = 'websocket';
    active.socket.addEventListener('open', () => {
      if (currentTurn !== active || !held || active.releaseRequested) {
        void cancelTurn(active);
        closeSocket(active.socket);
        clearAudio(active);
        if (currentTurn === active) currentTurn = null;
        return;
      }
      active.socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          model: 'higgs-realtime',
          instructions: setup.instructions,
          output_modalities: ['text'],
          audio: { input: {
            format: { type: 'audio/pcm', rate: TARGET_SAMPLE_RATE },
            noise_reduction: { type: 'near_field' },
            turn_detection: null,
          } },
          tools: [],
          tool_choice: 'none',
          temperature: 0.2,
          max_output_tokens: 160,
          truncation: 'disabled',
        },
      }));
      active.secret = '';
    });
    active.socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string' && currentTurn === active) handleProviderMessage(active, event.data);
    });
    active.socket.addEventListener('error', () => {
      void failTurn(active, 'Boson voice could not connect; local village dialogue remains available.');
    });
    active.socket.addEventListener('close', () => {
      if (currentTurn === active && active.phase !== 'waiting-response' && !active.completionSent) {
        void failTurn(active, 'Boson voice disconnected; local village dialogue remains available.');
      }
    });
  }

  async function beginHold(source = 'button') {
    if (!available || held || currentTurn || turnsUsed >= 10 || totalInputMs >= MAX_TOTAL_INPUT_MS) return;
    held = true;
    holdSource = source;
    turnsUsed += 1;
    const active = {
      generation: ++generation,
      phase: 'permission',
      releaseRequested: false,
      stream: null,
      audioContext: null,
      source: null,
      worklet: null,
      silence: null,
      socket: null,
      turnId: null,
      secret: '',
      allowedLineIds: [],
      pendingSamples: [],
      samplesSent: 0,
      responseText: '',
      terminalResponseText: null,
      terminalResponseCount: 0,
      responseOutputRejected: false,
      completionSent: false,
      cancelSent: false,
    };
    currentTurn = active;
    button.setAttribute('aria-pressed', 'true');
    button.textContent = 'Release to send';
    setStatus('Requesting microphone access for this held turn…');
    holdTimer = window.setTimeout(() => finishHold(true), MAX_HOLD_MS);
    let startupStage = 'microphone';
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access is unavailable in this browser.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      active.stream = stream;
      if (!held || currentTurn !== active || active.releaseRequested) {
        stopTracks(stream);
        if (currentTurn === active) currentTurn = null;
        return;
      }
      active.phase = 'awaiting-begin';
      startupStage = 'local-session';
      setStatus('Connecting to the nearest villager…');
      const response = await fetch('/boson-ptt/begin', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      const setup = await response.json().catch(() => ({}));
      if (typeof setup.turnId === 'string') active.turnId = setup.turnId;
      if (!response.ok || !setup.available || typeof setup.turnId !== 'string'
        || typeof setup.clientSecret !== 'string' || typeof setup.instructions !== 'string'
        || !validLineIds(setup.allowedLineIds)) {
        stopTracks(stream);
        if (currentTurn === active) currentTurn = null;
        resetHoldControl();
        if (active.turnId) await cancelTurn(active);
        setStatus(typeof setup.error === 'string' ? setup.error : 'Push-to-talk is unavailable; local village audio remains available.');
        return;
      }
      if (!held || currentTurn !== active || active.releaseRequested) {
        active.turnId = setup.turnId;
        stopTracks(stream);
        await cancelTurn(active);
        if (currentTurn === active) currentTurn = null;
        return;
      }
      void connectProvider(active, setup);
    } catch (error) {
      stopTracks(active.stream);
      if (active.releaseRequested || currentTurn !== active) return;
      if (currentTurn === active) currentTurn = null;
      resetHoldControl();
      const errorName = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
        ? error.name : '';
      const errorMessage = startupStage === 'microphone'
        ? errorName === 'NotAllowedError' || errorName === 'SecurityError'
          ? 'Microphone permission was denied or blocked. Allow microphone access for this page, then try again.'
          : errorName === 'NotFoundError'
            ? 'No microphone was found. Connect or select a microphone, then try again.'
            : errorName === 'NotReadableError' || errorName === 'AbortError'
              ? 'The microphone could not be opened. Close other apps using it, then try again.'
              : 'Microphone access failed. Check this page’s permission and selected input, then try again.'
        : 'The local Realtime session request failed. Check that this isolated viewer is running, then try again.';
      setStatus(errorMessage);
    }
  }

  async function finishHold(limitReached = false, source) {
    if (!held) return;
    if (source && source !== holdSource) return;
    resetHoldControl();
    const active = currentTurn;
    if (!active) return;
    if (active.phase === 'permission') {
      active.releaseRequested = true;
      currentTurn = null;
      setStatus('Microphone request cancelled; local village audio remains available.');
      return;
    }
    if (active.phase === 'awaiting-begin' || active.phase === 'websocket') {
      active.releaseRequested = true;
      clearAudio(active);
      if (active.turnId) await cancelTurn(active);
      setStatus('Turn cancelled before audio started.');
      return;
    }
    if (active.phase !== 'capturing') return;
    active.phase = 'waiting-response';
    clearAudio(active);
    if (active.samplesSent === 0 || active.socket?.readyState !== WebSocket.OPEN) {
      await cancelTurn(active);
      closeSocket(active.socket);
      currentTurn = null;
      setStatus('No speech was sent; local village dialogue remains available.');
      return;
    }
    active.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    setStatus(limitReached ? 'Hold limit reached; finishing the turn…' : 'Finishing the held turn…');
  }

  function onPointerDown(event) {
    if (button.disabled || held) return;
    event.preventDefault();
    try { button.setPointerCapture(event.pointerId); } catch { /* optional browser support */ }
    void beginHold('pointer');
  }
  function onPointerEnd(event) {
    if (!held || holdSource !== 'pointer') return;
    event?.preventDefault?.();
    void finishHold(false, 'pointer');
  }

  function isEditableTarget(target) {
    if (!target || typeof target !== 'object') return false;
    return target.isContentEditable === true
      || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      || Boolean(target.closest?.('[contenteditable=""], [contenteditable="true"], [role="textbox"]'));
  }

  function isPttSurface(target) {
    return target === document.body || target === document.documentElement || target === button
      || Boolean(document.pointerLockElement && target === document.pointerLockElement) || target?.tagName === 'CANVAS';
  }

  function onPttKeyDown(event) {
    if (event.code !== 'KeyP' || event.repeat || event.isComposing || button.disabled || held
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      || isEditableTarget(event.target) || !isPttSurface(event.target)) return;
    event.preventDefault();
    void beginHold('keyboard-p');
  }

  function onPttKeyUp(event) {
    if (event.code !== 'KeyP' || holdSource !== 'keyboard-p') return;
    event.preventDefault();
    void finishHold(false, 'keyboard-p');
  }

  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('pointerup', onPointerEnd);
  button.addEventListener('pointercancel', onPointerEnd);
  button.addEventListener('lostpointercapture', onPointerEnd);
  button.addEventListener('keydown', (event) => {
    if (!['Space', 'Enter'].includes(event.code) || event.repeat || button.disabled || held) return;
    event.preventDefault();
    void beginHold('button-key');
  });
  button.addEventListener('keyup', (event) => {
    if (!['Space', 'Enter'].includes(event.code) || holdSource !== 'button-key') return;
    event.preventDefault();
    void finishHold(false, 'button-key');
  });
  document.addEventListener('keydown', onPttKeyDown);
  document.addEventListener('keyup', onPttKeyUp);
  window.addEventListener('blur', () => { void finishHold(false); });
  window.addEventListener('pagehide', () => { void finishHold(false); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') void finishHold(false);
  });

  void fetch('/boson-ptt/status', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (response) => response.json())
    .then((result) => {
      available = Boolean(result.available);
      button.disabled = !available;
      setStatus(available ? 'Hold P to talk, or hold the button; release to send.'
        : typeof result.message === 'string' ? result.message : 'Push-to-talk is unavailable; local village audio remains available.');
    })
    .catch(() => {
      button.disabled = true;
      setStatus('Push-to-talk status is unavailable; local village audio remains available.');
    });
}

if (typeof document !== 'undefined') startViewerPtt();
