import { SpatialVoiceMixer, DEFAULT_MAX_DISTANCE, distanceBetween } from './audio/spatial-voice-mixer.js';

const MAX_PENDING_CLIPS = 24;
const MAX_RECENT_UTTERANCES = 512;

export function volumeForDistance(distance, maxDistance = DEFAULT_MAX_DISTANCE) {
  if (!Number.isFinite(distance) || distance < 0 || maxDistance <= 0) return 0;
  return 1 / (1 + distance / maxDistance);
}

export function isVillageDialogue(value) {
  return Boolean(value && value.type === 'village.dialogue'
    && typeof value.speakerId === 'string' && value.speakerId.length <= 128
    && typeof value.speakerName === 'string' && value.speakerName.length <= 128
    && typeof value.line === 'string' && value.line.length > 0 && value.line.length <= 500
    && value.position && ['x', 'y', 'z'].every((key) => Number.isFinite(value.position[key]))
    && Number.isFinite(value.timestamp));
}

export function startViewerAudio() {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !document.body) return () => {};
  const style = document.createElement('style');
  style.textContent = `
    #boson-audio { position: fixed; z-index: 5; right: 16px; top: 16px; width: min(340px, calc(100vw - 32px));
      box-sizing: border-box; padding: 12px; color: #f8fafc; background: rgba(15,23,42,.94);
      border: 1px solid rgba(148,163,184,.45); border-radius: 10px; font: 14px/1.4 system-ui,sans-serif; }
    #boson-audio strong { display:block; margin-bottom: 4px; } #boson-audio p { margin: 4px 0 10px; }
    #boson-audio button { margin-right: 6px; padding: 5px 10px; color: #f8fafc; background:#334155;
      border:1px solid #64748b; border-radius:5px; font:inherit; cursor:pointer; }
    #boson-audio button:focus-visible { outline: 3px solid #fbbf24; outline-offset: 2px; }
  `;
  document.head.append(style);
  const panel = document.createElement('section');
  panel.id = 'boson-audio';
  panel.setAttribute('aria-label', 'Village conversation audio');
  panel.innerHTML = '<strong>Village voices</strong><p id="boson-line" aria-live="polite">Enable audio to hear nearby residents.</p><button type="button" id="boson-enable">Enable audio</button><button type="button" id="boson-pause">Pause</button><button type="button" id="boson-stop">Stop</button><span id="boson-audio-status" role="status">Waiting for local voices</span>';
  document.body.append(panel);

  const line = panel.querySelector('#boson-line');
  const status = panel.querySelector('#boson-audio-status');
  const synth = window.speechSynthesis;
  const speechSupported = Boolean(synth && typeof window.SpeechSynthesisUtterance === 'function');
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  let enabled = false;
  let paused = false;
  let listener = null;
  let generation = 0;
  let pending = [];
  let inFlight = 0;
  let speechQueue = [];
  let speechActive = false;
  const recent = new Set();
  let context = null;
  let mixer = null;
  const aborters = new Set();
  const eventSource = new EventSource('/boson-dialogue');
  const positionSocket = window.io?.();

  const setStatus = (value) => { status.textContent = value; };
  const getVoices = () => speechSupported ? synth.getVoices().filter((voice) => voice.lang) : [];
  const localVoices = () => {
    const available = getVoices();
    const language = (document.documentElement.lang || window.navigator.language || '').split('-')[0].toLowerCase();
    const matching = available.filter((voice) => voice.lang.split('-')[0].toLowerCase() === language);
    return matching.length ? matching : available;
  };
  const hash = (text) => [...text].reduce((value, char) => ((value * 31) + char.charCodeAt(0)) >>> 0, 7);

  function setListener(packet) {
    const pos = packet?.pos ?? packet?.position;
    if (!pos || !['x', 'y', 'z'].every((key) => Number.isFinite(pos[key]))) return;
    listener = { x: pos.x, y: pos.y, z: pos.z, ...(Number.isFinite(packet.yaw) ? { yaw: packet.yaw } : {}) };
    mixer?.setListenerPosition(listener);
    pump();
  }

  async function ensureMixer() {
    if (!AudioContextClass) throw new Error('Web Audio is unavailable');
    if (!context) {
      context = new AudioContextClass();
      mixer = new SpatialVoiceMixer({ context, maxConcurrency: 3, onState: ({ type }) => {
        if (type === 'start') setStatus('Playing spatial resident voices');
      } });
    }
    await context.resume();
  }

  function speakFallback(event) {
    if (!speechSupported || !localVoices().length) {
      setStatus('Degraded · browser speech unavailable; subtitles remain available');
      return;
    }
    speechQueue.push(event);
    pumpFallback();
  }

  function pumpFallback() {
    if (paused || speechActive || !speechQueue.length || !speechSupported) return;
    const event = speechQueue.shift();
    const available = localVoices();
    if (!available.length) { setStatus('Degraded · waiting for browser speech voices'); speechQueue.unshift(event); return; }
    speechActive = true;
    const utterance = new window.SpeechSynthesisUtterance(event.line);
    utterance.voice = available[hash(event.speakerId) % available.length] ?? null;
    utterance.lang = utterance.voice?.lang || window.navigator.language;
    utterance.volume = volumeForDistance(listener ? distanceBetween(listener, event.position) : 0);
    utterance.pitch = 0.85 + (hash(event.speakerId) % 50) / 100;
    utterance.rate = 0.92 + (hash(event.speakerId + 'rate') % 17) / 100;
    const finished = () => { speechActive = false; pumpFallback(); };
    utterance.onend = finished;
    utterance.onerror = finished;
    setStatus('Degraded · browser SpeechSynthesis · serialized, non-layered');
    synth.speak(utterance);
  }

  function enqueue(event) {
    if (!isVillageDialogue(event)) return;
    const id = event.eventId || `${event.speakerId}:${event.timestamp}:${event.line}`;
    if (recent.has(id)) return;
    recent.add(id);
    if (recent.size > MAX_RECENT_UTTERANCES) recent.delete(recent.values().next().value);
    if (!listener || distanceBetween(listener, event.position) >= DEFAULT_MAX_DISTANCE) return;
    line.textContent = `${event.speakerName}: ${event.line}`;
    if (!enabled || paused) { pending.push({ event, generation }); trimPending(); return; }
    pending.push({ event, generation });
    trimPending();
    pump();
  }

  function trimPending() {
    while (pending.length > MAX_PENDING_CLIPS) pending.shift();
  }

  function pump() {
    if (!enabled || paused || !listener) return;
    while (inFlight < 3 && pending.length) {
      const item = pending.shift();
      if (item.generation !== generation || distanceBetween(listener, item.event.position) >= DEFAULT_MAX_DISTANCE) continue;
      inFlight += 1;
      void render(item);
    }
  }

  async function render(item) {
    const { event } = item;
    const controller = new AbortController();
    aborters.add(controller);
    try {
      if (!event.eventId || !event.lineId) throw new Error('No trusted authored voice identity');
      await ensureMixer();
      const response = await fetch('/boson-tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: event.eventId, speakerId: event.speakerId }), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`TTS unavailable (${response.status})`);
      if (!response.headers.get('content-type')?.includes('audio/mpeg')) throw new Error('TTS returned an unsupported clip format');
      const bytes = await response.arrayBuffer();
      if (item.generation !== generation || controller.signal.aborted) return;
      const buffer = await context.decodeAudioData(bytes);
      if (buffer.duration > 30) throw new Error('TTS clip exceeded the playback duration cap');
      mixer.setListenerPosition(listener);
      mixer.enqueue({ speakerId: event.speakerId, utteranceId: event.eventId, buffer, position: event.position });
      setStatus(`Boson Higgs TTS · ${response.headers.get('x-boson-usage-characters') ?? 'metered'} characters · spatial playback`);
    } catch {
      if (item.generation === generation && !controller.signal.aborted) speakFallback(event);
    } finally {
      aborters.delete(controller);
      inFlight -= 1;
      pump();
    }
  }

  function stopPlayback() {
    generation += 1;
    pending = [];
    speechQueue = [];
    for (const controller of aborters) controller.abort();
    aborters.clear();
    mixer?.stopAll();
    if (speechSupported) synth.cancel();
    speechActive = false;
  }

  const onDialogue = (event) => {
    try { enqueue(JSON.parse(event.data)); } catch { setStatus('Received an invalid dialogue event'); }
  };
  const onVoices = () => {
    if (!localVoices().length) return;
    if (!enabled) setStatus('Audio ready · browser fallback available');
    pumpFallback();
  };
  const onEnable = async () => {
    enabled = true;
    try { await ensureMixer(); setStatus('Spatial audio enabled; local fallback available'); }
    catch { setStatus('Degraded · Web Audio unavailable; browser fallback ready'); }
    pump();
  };
  const onPause = async (event) => {
    if (!speechSupported && !mixer) return;
    paused = !paused;
    if (paused) { await context?.suspend?.(); if (speechSupported) synth.pause(); }
    else { await context?.resume?.(); if (speechSupported) synth.resume(); pump(); pumpFallback(); }
    event.currentTarget.textContent = paused ? 'Resume' : 'Pause';
    setStatus(paused ? 'Paused' : 'Audio resumed');
  };
  const onStop = () => {
    stopPlayback();
    paused = false;
    panel.querySelector('#boson-pause').textContent = 'Pause';
    setStatus('Stopped');
  };
  const onPageHide = () => cleanup();
  eventSource.addEventListener('dialogue', onDialogue);
  eventSource.onerror = () => setStatus('Dialogue stream disconnected');
  positionSocket?.on('position', setListener);
  if (speechSupported) synth.addEventListener('voiceschanged', onVoices);
  panel.querySelector('#boson-enable').addEventListener('click', onEnable);
  panel.querySelector('#boson-pause').addEventListener('click', onPause);
  panel.querySelector('#boson-stop').addEventListener('click', onStop);
  window.addEventListener('pagehide', onPageHide, { once: true });

  function cleanup() {
    stopPlayback();
    eventSource.close();
    positionSocket?.close?.();
    if (speechSupported) synth.removeEventListener('voiceschanged', onVoices);
    mixer?.close();
    panel.remove();
    style.remove();
    window.removeEventListener('pagehide', onPageHide);
  }
  if (!speechSupported) setStatus('SpeechSynthesis unavailable · Higgs spatial audio can still play');
  return cleanup;
}

if (typeof document !== 'undefined') startViewerAudio();
