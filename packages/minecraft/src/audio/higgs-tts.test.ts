import assert from 'node:assert/strict';
import test from 'node:test';
import { createHiggsTtsHandler, RESIDENT_VOICES, TTS_CHARACTER_USD } from './higgs-tts.js';

function request(body, method = 'POST') {
  return {
    method, url: '/boson-tts', headers: { 'content-length': String(Buffer.byteLength(body)), origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
}

const allowSameOrigin = (req) => req.headers.origin === 'http://127.0.0.1:3000' && req.headers['sec-fetch-site'] === 'same-origin';

function response() {
  return { writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
}

function mp3Frames(count) {
  const frameLength = 417; // MPEG-1 Layer III, 128 kbps, 44.1 kHz.
  const bytes = new Uint8Array(frameLength * count);
  for (let index = 0; index < count; index += 1) bytes.set([0xff, 0xfb, 0x90, 0x64], index * frameLength);
  return bytes;
}

test('Higgs helper synthesizes only trusted resolved text and reports character usage', async () => {
  let payload;
  let calls = 0;
  const handler = createHiggsTtsHandler({
    isAllowedRequest: allowSameOrigin,
    apiKey: 'test-secret', maxCharacters: 30,
    resolveUtterance: async (eventId, speakerId) => eventId === 'e1' && speakerId === 'mira'
      ? { lineId: 'ambient-1', text: 'Good morning.', voice: RESIDENT_VOICES.mira } : null,
    fetcher: async (_url, options) => { calls += 1; payload = JSON.parse(options.body); assert.equal(options.headers.Authorization, 'Bearer test-secret'); return new Response(mp3Frames(1)); },
  });
  const res = response();
  assert.equal(await handler.handleRequest(request(JSON.stringify({ eventId: 'e1', speakerId: 'mira' })), res), true);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(payload.model, 'higgs-tts-3');
  assert.equal(payload.input, 'Good morning.');
  assert.equal(payload.voice, 'chloe');
  assert.equal(res.headers['X-Boson-Usage-Characters'], '13');
  assert.equal(handler.getUsage().estimatedUsd, Number((13 * TTS_CHARACTER_USD).toFixed(6)));
  assert.equal(JSON.stringify(res.headers).includes('test-secret'), false);
  const retry = response();
  await handler.handleRequest(request(JSON.stringify({ eventId: 'e1', speakerId: 'mira' })), retry);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers['X-Boson-Cache'], 'HIT');
  assert.equal(calls, 1);
  assert.equal(handler.getUsage().requests, 1);
});

test('endpoint rejects arbitrary text and enforces the cumulative run character cap', async () => {
  let calls = 0;
  const handler = createHiggsTtsHandler({
    isAllowedRequest: allowSameOrigin,
    apiKey: 'test-secret', maxCharacters: 8,
    resolveUtterance: async () => ({ lineId: 'ambient-2', text: 'Hello!', voice: RESIDENT_VOICES.pip }),
    fetcher: async () => { calls += 1; return new Response(mp3Frames(1)); },
  });
  const invalid = response();
  await handler.handleRequest(request(JSON.stringify({ eventId: 'e2', speakerId: 'pip', text: 'attacker text' })), invalid);
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  const first = response();
  await handler.handleRequest(request(JSON.stringify({ eventId: 'e2', speakerId: 'pip' })), first);
  assert.equal(first.status, 200);
  const second = response();
  await handler.handleRequest(request(JSON.stringify({ eventId: 'e3', speakerId: 'pip' })), second);
  assert.equal(second.status, 429);
  assert.equal(calls, 1);
  assert.equal(handler.getUsage().characters, 6);
});

test('missing credentials and untrusted speaker voice use an explicit unavailable response', async () => {
  const missing = createHiggsTtsHandler({ isAllowedRequest: allowSameOrigin, apiKey: '', resolveUtterance: async () => null });
  const missingResponse = response();
  await missing.handleRequest(request('{}'), missingResponse);
  assert.equal(missingResponse.status, 503);
  const badVoice = createHiggsTtsHandler({
    isAllowedRequest: allowSameOrigin,
    apiKey: 'test', resolveUtterance: async () => ({ lineId: 'ambient-1', text: 'Hello.', voice: 'invented' }),
    fetcher: async () => { throw new Error('must not call provider'); },
  });
  const badResponse = response();
  await badVoice.handleRequest(request(JSON.stringify({ eventId: 'e3', speakerId: 'mira' })), badResponse);
  assert.equal(badResponse.status, 404);
  assert.equal(badVoice.getUsage().requests, 0);
});

test('provider failures are reported, counted conservatively, and never expose credentials', async () => {
  const handler = createHiggsTtsHandler({ isAllowedRequest: allowSameOrigin, apiKey: 'secret-value', resolveUtterance: async () => ({ lineId: 'x', text: 'Hi.', voice: 'jake' }), fetcher: async () => { throw new Error('network'); } });
  const res = response();
  await handler.handleRequest(request(JSON.stringify({ eventId: 'e4', speakerId: 'pip' })), res);
  assert.equal(res.status, 502);
  assert.equal(handler.getUsage().requests, 1);
  assert.equal(JSON.stringify(res.body).includes('secret-value'), false);
});

test('provider clips exceeding the configured audio duration cap are rejected', async () => {
  const handler = createHiggsTtsHandler({
    isAllowedRequest: allowSameOrigin,
    apiKey: 'test', maxDurationSeconds: 1,
    resolveUtterance: async () => ({ lineId: 'ambient-1', text: 'Hello.', voice: 'chloe' }),
    fetcher: async () => new Response(mp3Frames(45)),
  });
  const res = response();
  await handler.handleRequest(request(JSON.stringify({ eventId: 'e5', speakerId: 'mira' })), res);
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /over-duration/);
});

test('same-origin gate fails closed and rejects cross-origin requests before lookup or spend', async () => {
  let lookups = 0;
  let fetches = 0;
  const handler = createHiggsTtsHandler({
    isAllowedRequest: allowSameOrigin,
    apiKey: 'test',
    resolveUtterance: async () => { lookups += 1; return { lineId: 'ambient-1', text: 'Hello.', voice: 'chloe' }; },
    fetcher: async () => { fetches += 1; return new Response(mp3Frames(1)); },
  });
  const payload = JSON.stringify({ eventId: 'origin-test', speakerId: 'mira' });
  const crossOriginRequest = request(payload);
  crossOriginRequest.headers.origin = 'https://attacker.example';
  const crossOriginResponse = response();
  await handler.handleRequest(crossOriginRequest, crossOriginResponse);
  assert.equal(crossOriginResponse.status, 403);
  assert.equal(lookups, 0);
  assert.equal(fetches, 0);
  assert.equal(handler.getUsage().eventLookups, 0);

  const missingGuard = createHiggsTtsHandler({ apiKey: 'test', resolveUtterance: async () => { lookups += 1; return null; } });
  const noGuardResponse = response();
  await missingGuard.handleRequest(request(payload), noGuardResponse);
  assert.equal(noGuardResponse.status, 403);
  assert.equal(lookups, 0);
  assert.equal(missingGuard.getUsage().rejectedRequests, 1);
});

test('invalid authored-event lookups do not grow retained identity state and have a hard request cap', async () => {
  let lookups = 0;
  let fetches = 0;
  const handler = createHiggsTtsHandler({
    isAllowedRequest: allowSameOrigin,
    apiKey: 'test',
    maxLookupRequests: 20,
    maxEventJobs: 2,
    resolveUtterance: async () => { lookups += 1; return null; },
    fetcher: async () => { fetches += 1; throw new Error('should not reach provider'); },
  });
  for (let index = 0; index < 20; index += 1) {
    const res = response();
    await handler.handleRequest(request(JSON.stringify({ eventId: `missing-${index}`, speakerId: 'mira' })), res);
    assert.equal(res.status, 404);
  }
  assert.equal(handler.getUsage().retainedUtteranceCacheEntries, 0);
  assert.equal(lookups, 20);
  const overLimit = response();
  await handler.handleRequest(request(JSON.stringify({ eventId: 'missing-extra', speakerId: 'mira' })), overLimit);
  assert.equal(overLimit.status, 429);
  assert.equal(handler.getUsage().retainedUtteranceCacheEntries, 0);
  assert.equal(fetches, 0);
});

test('trusted event cache has a fixed retention bound', async () => {
  const handler = createHiggsTtsHandler({
    isAllowedRequest: allowSameOrigin,
    apiKey: 'test',
    maxEventJobs: 2,
    resolveUtterance: async () => ({ lineId: 'ambient-1', text: 'Hello.', voice: 'chloe' }),
    fetcher: async () => new Response(mp3Frames(1)),
  });
  for (let index = 0; index < 3; index += 1) {
    const res = response();
    await handler.handleRequest(request(JSON.stringify({ eventId: `valid-${index}`, speakerId: 'mira' })), res);
    assert.equal(res.status, 200);
  }
  assert.equal(handler.getUsage().retainedUtteranceCacheEntries, 2);
});

test('concurrent requests for one utterance share one provider request', async () => {
  let calls = 0;
  let release;
  const handler = createHiggsTtsHandler({
    isAllowedRequest: allowSameOrigin,
    apiKey: 'test', resolveUtterance: async () => ({ lineId: 'ambient-1', text: 'Hello.', voice: 'chloe' }),
    fetcher: async () => { calls += 1; await new Promise((resolve) => { release = resolve; }); return new Response(mp3Frames(1)); },
  });
  const payload = JSON.stringify({ eventId: 'same-event', speakerId: 'mira' });
  const a = response();
  const b = response();
  const first = handler.handleRequest(request(payload), a);
  const second = handler.handleRequest(request(payload), b);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(handler.getUsage().requests, 1);
});
