export const HIGGS_TTS_ENDPOINT = 'https://api.boson.ai/v1/audio/speech';
export const HIGGS_TTS_MODEL = 'higgs-tts-3';
export const TTS_CHARACTER_USD = 0.015 / 1000;
export const RESIDENT_VOICES = Object.freeze({ mira: 'chloe', tobin: 'oliver', pip: 'jake' });

/** Server-side only adapter. Text must come from a trusted resolver, never the request body. */
export function createHiggsTtsHandler({
  resolveUtterance,
  isAllowedRequest,
  fetcher = globalThis.fetch,
  apiKey = process.env.BOSON_API_KEY,
  maxCharacters = 1000,
  maxRequests = 100,
  maxAudioBytes = 4_000_000,
  maxAudioCacheBytes = 16_000_000,
  maxDurationSeconds = 30,
  maxEventJobs = 128,
  maxLookupRequests = 1000,
  endpoint = HIGGS_TTS_ENDPOINT,
} = {}) {
  if (typeof resolveUtterance !== 'function') throw new TypeError('resolveUtterance is required');
  const budget = { characters: 0, requests: 0, estimatedUsd: 0, succeededRequests: 0, failedRequests: 0, outcomeUnknownRequests: 0, eventLookups: 0, rejectedRequests: 0, actualProviderUsage: null };
  const eventJobs = new Map();
  let cachedBytes = 0;
  let closed = false;

  return {
    getUsage: () => ({ ...budget, retainedUtteranceCacheEntries: eventJobs.size }),
    close: () => { closed = true; },
    async handleRequest(request, response) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/boson-tts') return false;
      let allowed = false;
      try { allowed = typeof isAllowedRequest === 'function' && isAllowedRequest(request) === true; } catch {}
      if (!allowed) {
        budget.rejectedRequests += 1;
        return json(response, 403, { error: 'Local same-origin viewer requests only' });
      }
      if (request.method !== 'POST') return json(response, 405, { error: 'POST required' }, { Allow: 'POST' });
      if (closed) return json(response, 503, { error: 'TTS service is closed' });
      if (!apiKey) return json(response, 503, { error: 'Higgs TTS is unavailable; local speech fallback is active' });
      if (!fetcher) return json(response, 503, { error: 'Higgs TTS transport is unavailable' });
      let body;
      try { body = await readJson(request, 512); } catch { return json(response, 400, { error: 'Invalid TTS request' }); }
      if (!body || Object.keys(body).sort().join(',') !== 'eventId,speakerId'
        || !safeId(body.eventId) || !safeId(body.speakerId)) return json(response, 400, { error: 'Expected eventId and speakerId' });
      if (budget.eventLookups >= maxLookupRequests) return json(response, 429, { error: 'TTS lookup request limit reached' });
      budget.eventLookups += 1;
      let utterance;
      try { utterance = await resolveUtterance(body.eventId, body.speakerId); } catch { return json(response, 404, { error: 'Authored utterance unavailable' }); }
      if (!validUtterance(utterance, body.speakerId)) return json(response, 404, { error: 'Authored utterance unavailable' });
      const eventKey = `${body.speakerId}:${body.eventId}`;
      const prior = eventJobs.get(eventKey);
      if (prior) {
        eventJobs.delete(eventKey);
        eventJobs.set(eventKey, prior);
        if (prior.promise) return sendResult(response, await prior.promise, true);
        if (prior.result?.audio) return sendResult(response, prior.result, true);
        return json(response, 409, { error: 'This utterance was already attempted; duplicate synthesis is suppressed', usage: { ...budget } });
      }
      if (eventJobs.size >= maxEventJobs) {
        const oldestEvictable = [...eventJobs.entries()].find(([, job]) => !job.promise);
        if (!oldestEvictable) return json(response, 429, { error: 'TTS request queue is full' });
        eventJobs.delete(oldestEvictable[0]);
        cachedBytes -= oldestEvictable[1].result?.audio?.length ?? 0;
      }
      // Event identity is retained only after the trusted resolver validates it.
      const job = { promise: null, result: null };
      eventJobs.set(eventKey, job);
      job.promise = synthesize(utterance);
      const result = await job.promise;
      job.promise = null;
      job.result = result.audio && cachedBytes + result.audio.length <= maxAudioCacheBytes ? result : { status: 409 };
      if (job.result.audio) cachedBytes += result.audio.length;
      return sendResult(response, result, false);

      async function synthesize(utterance) {
        const characterCount = [...utterance.text].length;
        if (characterCount === 0 || characterCount > 500) return { status: 422, error: 'Authored line is outside the TTS input limit' };
        if (budget.requests >= maxRequests || budget.characters + characterCount > maxCharacters) return { status: 429, error: 'TTS run budget exhausted' };
        // Reserve before sending: a failed request may have reached the metered provider.
        budget.requests += 1;
        budget.characters += characterCount;
        budget.estimatedUsd = Number((budget.characters * TTS_CHARACTER_USD).toFixed(6));
        const headers = {
          'X-Boson-Usage-Characters': String(characterCount),
          'X-Boson-Usage-Requests': String(budget.requests),
          'X-Boson-Estimated-Cost-USD': (characterCount * TTS_CHARACTER_USD).toFixed(6),
        };
      let upstream;
      try {
        upstream = await fetcher(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: HIGGS_TTS_MODEL, input: utterance.text, voice: utterance.voice, response_format: 'mp3', stream: false }),
        });
      } catch {
          budget.failedRequests += 1;
          budget.outcomeUnknownRequests += 1;
          return { status: 502, error: 'Higgs TTS request failed', headers, usage: { ...budget } };
      }
      if (!upstream.ok) {
        try { await upstream.body?.cancel(); } catch {}
          budget.failedRequests += 1;
          budget.outcomeUnknownRequests += 1;
          return { status: 502, error: 'Higgs TTS provider returned an error', headers, usage: { ...budget } };
      }
      let audio;
      try {
        audio = new Uint8Array(await upstream.arrayBuffer());
      } catch {
          budget.failedRequests += 1;
          budget.outcomeUnknownRequests += 1;
          return { status: 502, error: 'Higgs TTS audio response was invalid', headers, usage: { ...budget } };
      }
      const durationSeconds = mp3DurationSeconds(audio);
      if (audio.length > maxAudioBytes || durationSeconds === null || durationSeconds > maxDurationSeconds) {
          budget.failedRequests += 1;
          budget.outcomeUnknownRequests += 1;
          return { status: 502, error: 'Higgs TTS returned an invalid, oversized, or over-duration clip', headers, usage: { ...budget } };
      }
        budget.succeededRequests += 1;
        return { status: 200, audio, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length), 'Cache-Control': 'no-store', ...headers } };
      }
    },
  };
}

function sendResult(response, result, cached) {
  if (result.status !== 200) return json(response, result.status, { error: result.error ?? 'TTS unavailable', usage: result.usage });
  response.writeHead(200, { ...result.headers, ...(cached ? { 'X-Boson-Cache': 'HIT' } : {}) });
  response.end(Buffer.from(result.audio));
  return true;
}

function validUtterance(value, speakerId) {
  return Boolean(value && typeof value === 'object'
    && typeof value.lineId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value.lineId)
    && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 500
    && value.voice === RESIDENT_VOICES[speakerId]);
}

function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value); }

function mp3DurationSeconds(bytes) {
  let offset = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const tagBytes = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + tagBytes + ((bytes[5] & 0x10) ? 10 : 0);
  }
  const mpeg1Layer3Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const mpeg2Layer3Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRates = [44100, 48000, 32000];
  let seconds = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    const header = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    if ((header >>> 21) !== 0x7ff) return null;
    const version = (header >>> 19) & 0x3;
    const layer = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xf;
    const rateIndex = (header >>> 10) & 0x3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
    const mpeg1 = version === 3;
    const sampleRate = sampleRates[rateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
    const bitrate = (mpeg1 ? mpeg1Layer3Bitrates : mpeg2Layer3Bitrates)[bitrateIndex] * 1000;
    const frameLength = Math.floor((mpeg1 ? 144 : 72) * bitrate / sampleRate) + ((header >>> 9) & 1);
    if (frameLength < 4 || offset + frameLength > bytes.length) return null;
    seconds += (mpeg1 ? 1152 : 576) / sampleRate;
    offset += frameLength;
    frames += 1;
  }
  return frames > 0 && offset === bytes.length ? seconds : null;
}

async function readJson(request, maxBytes) {
  if (Number(request.headers?.['content-length']) > maxBytes) throw new Error('request too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
  return true;
}
