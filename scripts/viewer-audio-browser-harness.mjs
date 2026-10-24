import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { isVillageDialogue } from '../packages/minecraft/src/viewer-audio.js';

const audioModule = new URL('../packages/minecraft/src/viewer-audio.js', import.meta.url);
const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boson browser audio acceptance</title>
<style>
  body { margin: 24px; color: #e2e8f0; background: #0f172a; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 850px; margin: auto; } button { margin: 4px; padding: 7px 12px; }
  pre { min-height: 8em; overflow: auto; padding: 12px; background: #1e293b; white-space: pre-wrap; }
</style>
<main>
  <h1>Boson browser audio acceptance</h1>
  <p>This page runs the production viewer audio client and local browser SpeechSynthesis. No Minecraft server, microphone, or paid service is used.</p>
  <p><button id="enable">Enable audio</button><button id="position">Set explorer position (0, 64, 0)</button></p>
  <p><button id="near">Send nearby Anna dialogue</button><button id="far">Send distant James dialogue</button></p>
  <p><button id="pause">Pause, then send a queued line</button><button id="resume">Resume</button><button id="stop">Stop</button></p>
  <h2>Browser evidence</h2><pre id="evidence">Starting event stream…</pre>
</main>
<script>
  const evidence = document.querySelector('#evidence');
  const records = [];
  let explorerHandler;
  const nativeSpeak = window.speechSynthesis?.speak?.bind(window.speechSynthesis);
  if (nativeSpeak) {
    window.speechSynthesis.speak = (utterance) => {
      records.push({ text: utterance.text, voice: utterance.voice?.name ?? null, lang: utterance.voice?.lang ?? null,
        volume: utterance.volume, pitch: utterance.pitch, rate: utterance.rate, submittedAt: new Date().toISOString() });
      render();
      return nativeSpeak(utterance);
    };
  }
  function render() {
    const voices = window.speechSynthesis?.getVoices?.() ?? [];
    evidence.textContent = JSON.stringify({ speechSynthesis: Boolean(nativeSpeak), voiceCount: voices.length,
      availableVoiceLanguages: [...new Set(voices.map(({lang}) => lang))].sort(),
      playback: { speaking: window.speechSynthesis?.speaking, paused: window.speechSynthesis?.paused,
        pending: window.speechSynthesis?.pending },
      utterancesSubmittedToNativeSpeechSynthesis: records,
      subtitle: document.querySelector('#boson-line')?.textContent ?? '(audio client not loaded yet)',
      status: document.querySelector('#boson-audio-status')?.textContent ?? '(audio client not loaded yet)' }, null, 2);
  }
  window.renderEvidence = render;
  window.io = () => ({ on(event, handler) { if (event === 'position') explorerHandler = handler; } });
  window.setExplorer = (pos = { x: 0, y: 64, z: 0 }) => { explorerHandler?.({ pos }); render(); };
  window.sendDialogue = async (speakerId, speakerName, line, position) => {
    const response = await fetch('/boson-dialogue', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'village.dialogue', speakerId, speakerName, line, position, timestamp: Date.now() }) });
    document.querySelector('#harness-result').textContent = 'POST ' + response.status;
    render();
  };
  document.querySelector('#enable').onclick = () => document.querySelector('#boson-enable')?.click();
  document.querySelector('#position').onclick = () => window.setExplorer();
  document.querySelector('#near').onclick = () => window.sendDialogue('mira', 'Anna', 'Good morning, the bakery is open.', {x: 0, y: 64, z: 0});
  document.querySelector('#far').onclick = () => window.sendDialogue('tobin', 'James', 'I am tending the fields on the far side of the village.', {x: 48, y: 64, z: 0});
  document.querySelector('#pause').onclick = () => { document.querySelector('#boson-pause')?.click(); window.sendDialogue('mira', 'Anna', 'I will wait here while you pause.', {x: 2, y: 64, z: 0}); };
  document.querySelector('#resume').onclick = () => document.querySelector('#boson-pause')?.click();
  document.querySelector('#stop').onclick = () => document.querySelector('#boson-stop')?.click();
  window.addEventListener('load', render);
  window.speechSynthesis?.addEventListener('voiceschanged', render);
</script>
<p id="harness-result" role="status"></p>
  <script type="module">
    await import('/boson-audio.js');
    const panel = document.querySelector('#boson-audio');
    if (panel) new MutationObserver(window.renderEvidence).observe(panel, { childList: true, subtree: true, characterData: true });
    window.renderEvidence();
  </script>`;

const clients = new Set();
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
    return;
  }
  if (request.method === 'GET' && pathname === '/boson-audio.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(await readFile(audioModule));
    return;
  }
  if (pathname !== '/boson-dialogue') {
    response.writeHead(404).end('Not found');
    return;
  }
  if (request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(': connected\n\n');
    clients.add(response);
    response.once('close', () => clients.delete(response));
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'GET, POST' }).end();
    return;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) {
      response.writeHead(413).end('Event too large');
      return;
    }
    chunks.push(chunk);
  }
  try {
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isVillageDialogue(event)) {
      response.writeHead(400).end('Invalid village dialogue event');
      return;
    }
    const message = `event: dialogue\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(message);
    response.writeHead(202).end('Accepted');
  } catch {
    response.writeHead(400).end('Invalid JSON');
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Audio harness ready at http://127.0.0.1:${address.port}/`);
  console.log('Use the page buttons to enable local speech, set explorer position, and send nearby/far dialogue. Press Ctrl+C to stop.');
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
