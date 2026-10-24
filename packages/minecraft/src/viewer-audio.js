const MAX_DISTANCE = 48;

export function volumeForDistance(distance, maxDistance = MAX_DISTANCE) {
  if (!Number.isFinite(distance) || distance < 0) return 0;
  if (!Number.isFinite(maxDistance) || maxDistance <= 0) return 0;
  return 1 / (1 + distance / maxDistance);
}

export function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
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
  let enabled = false;
  let paused = false;
  let explorer = null;
  let pendingEvent = null;
  let activeUtterance = null;
  const voices = () => {
    if (!speechSupported) return [];
    const available = synth.getVoices().filter((voice) => voice.lang);
    const language = (document.documentElement.lang || window.navigator.language || '').split('-')[0].toLowerCase();
    const matching = available.filter((voice) => voice.lang.split('-')[0].toLowerCase() === language);
    return matching.length ? matching : available;
  };
  if (!speechSupported) status.textContent = 'Browser speech synthesis is unavailable';
  const hash = (text) => [...text].reduce((value, char) => ((value * 31) + char.charCodeAt(0)) >>> 0, 7);
  const positionSocket = window.io?.();
  positionSocket?.on('position', (packet) => {
    if (packet?.pos && ['x', 'y', 'z'].every((key) => Number.isFinite(packet.pos[key]))) {
      explorer = packet.pos;
      if (enabled && pendingEvent && !paused && voices().length) speak(pendingEvent);
    }
  });

  const speak = (event) => {
    if (!isVillageDialogue(event)) return;
    line.textContent = `${event.speakerName}: ${event.line}`;
    if (paused || !enabled || !explorer || !voices().length) {
      pendingEvent = event;
      if (enabled && speechSupported && !voices().length) status.textContent = 'Waiting for local browser voices';
      return;
    }
    pendingEvent = null;
    const volume = volumeForDistance(distanceBetween(explorer, event.position));
    if (volume <= 0) return;
    activeUtterance = null;
    synth.cancel();
    const utterance = new window.SpeechSynthesisUtterance(event.line);
    const available = voices();
    utterance.voice = available[hash(event.speakerId) % available.length] ?? null;
    utterance.lang = utterance.voice?.lang || window.navigator.language;
    utterance.volume = volume;
    utterance.pitch = 0.85 + (hash(event.speakerId) % 50) / 100;
    utterance.rate = 0.92 + (hash(event.speakerId + 'rate') % 17) / 100;
    const voiceName = utterance.voice?.name ?? 'Default voice';
    const distanceVolume = Math.round(volume * 100);
    activeUtterance = utterance;
    status.textContent = `Queued · ${voiceName} · distance volume ${distanceVolume}%`;
    utterance.onstart = () => {
      if (activeUtterance === utterance) status.textContent = `Speaking · ${voiceName} · distance volume ${distanceVolume}%`;
    };
    utterance.onend = () => {
      if (activeUtterance === utterance) {
        activeUtterance = null;
        status.textContent = 'Ready';
      }
    };
    utterance.onerror = () => {
      if (activeUtterance === utterance) {
        activeUtterance = null;
        status.textContent = 'Speech playback failed';
      }
    };
    synth.speak(utterance);
  };

  const stream = new EventSource('/boson-dialogue');
  stream.addEventListener('dialogue', (event) => {
    try { speak(JSON.parse(event.data)); } catch { status.textContent = 'Received an invalid dialogue event'; }
  });
  stream.onerror = () => { status.textContent = 'Dialogue stream disconnected'; };
  if (speechSupported) synth.addEventListener('voiceschanged', () => {
    if (!voices().length) return;
    status.textContent = 'Local browser voices ready';
    if (enabled && pendingEvent && !paused) speak(pendingEvent);
  });
  panel.querySelector('#boson-enable').addEventListener('click', () => {
    enabled = true;
    status.textContent = !speechSupported ? 'Browser speech synthesis is unavailable'
      : voices().length ? 'Local speech enabled' : 'Waiting for local browser voices';
    if (enabled && pendingEvent && !paused && voices().length) speak(pendingEvent);
  });
  panel.querySelector('#boson-pause').addEventListener('click', (event) => {
    if (!speechSupported) return;
    paused = !paused;
    if (paused) synth.pause();
    else if (pendingEvent) {
      synth.cancel();
      synth.resume();
      const latest = pendingEvent;
      pendingEvent = null;
      speak(latest);
    } else synth.resume();
    event.currentTarget.textContent = paused ? 'Resume' : 'Pause';
    status.textContent = paused ? 'Paused' : 'Ready';
  });
  panel.querySelector('#boson-stop').addEventListener('click', () => {
    synth?.cancel();
    activeUtterance = null;
    paused = false;
    pendingEvent = null;
    panel.querySelector('#boson-pause').textContent = 'Pause';
    status.textContent = 'Stopped';
  });
}

if (typeof document !== 'undefined') startViewerAudio();
