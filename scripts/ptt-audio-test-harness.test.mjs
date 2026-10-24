import assert from 'node:assert/strict';
import test from 'node:test';
import { FIXED_AUTHORED_LINE, FIXED_RESIDENT, startPttAudioHarness } from './ptt-audio-test-harness.mjs';

test('isolated audio harness serves production modules behind local security and usage caps', async (context) => {
  const harness = await startPttAudioHarness({ port: 0, host: '127.0.0.1', providerEnabled: false });
  context.after(() => harness.close());

  const pageResponse = await fetch(harness.url);
  assert.equal(pageResponse.status, 200);
  const browserNavigation = await fetch(harness.url, { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none' } });
  assert.equal(browserNavigation.status, 200);
  const forgedNavigation = await fetch(harness.url, { headers: { Origin: 'http://example.invalid', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(forgedNavigation.status, 403);
  const page = await pageResponse.text();
  const csp = pageResponse.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /wss:\/\/api\.boson\.ai/);
  assert.match(page, /Fixed public resident fixture/);
  assert.match(page, /30 seconds/);
  assert.match(page, /one real held turn/i);
  assert.match(page, /120 characters/);
  assert.match(page, /No Minecraft world/);
  assert.doesNotMatch(page, /<iframe\b/i);

  for (const asset of [
    '/boson-ptt.js',
    '/boson-audio.js',
    '/boson-ptt-worklet.js',
    '/village-vocabulary.js',
    '/audio/spatial-voice-mixer.js',
  ]) {
    const response = await fetch(new URL(asset, harness.url));
    assert.equal(response.status, 200, `${asset} should be served`);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
  }

  const statusResponse = await fetch(new URL('/harness/status', harness.url));
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.deepEqual(status.fixture, { speakerId: 'mira', speakerName: 'Anna', lineId: 'mira-greeting' });
  assert.equal(status.limits.realtimeTurns, 1);
  assert.equal(status.limits.maxHoldMs, 30_000);
  assert.equal(status.limits.ttsRequests, 1);
  assert.equal(status.limits.ttsCharacters, 120);
  assert.equal(status.usage.realtimeTurns, 0);
  assert.equal(status.usage.tts.requests, 0);
  assert.equal(status.usage.tts.actualProviderUsage, null);
  assert.deepEqual(FIXED_RESIDENT.facts, ['The garden is growing well today.']);
  assert.ok(FIXED_AUTHORED_LINE.text.length <= status.limits.ttsCharacters);
  assert.deepEqual(FIXED_RESIDENT.responseOptions.map(({ lineId }) => lineId), ['mira-greeting']);

  const localOrigin = new URL(harness.url).origin;
  const firstBegin = await fetch(new URL('/boson-ptt/begin', harness.url), {
    method: 'POST',
    headers: { Origin: localOrigin, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(firstBegin.status, 503, 'provider-disabled test must not mint a credential');
  const secondBegin = await fetch(new URL('/boson-ptt/begin', harness.url), {
    method: 'POST',
    headers: { Origin: localOrigin, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(secondBegin.status, 429, 'the one-turn cap rejects every later attempt');
  const afterBegin = await fetch(new URL('/harness/status', harness.url)).then((response) => response.json());
  assert.equal(afterBegin.usage.realtimeTurns, 1);

  const blockedTts = await fetch(new URL('/boson-tts', harness.url), {
    method: 'POST',
    headers: { Origin: 'http://example.invalid', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: 'fixture-1', speakerId: 'mira' }),
  });
  assert.equal(blockedTts.status, 403);
  const afterBlockedTts = await fetch(new URL('/harness/status', harness.url)).then((response) => response.json());
  assert.equal(afterBlockedTts.usage.tts.requests, 0);
});

test('mocked provider flow begins, completes, resolves the authored event, and caps TTS without network access', async (context) => {
  let realtimeCalls = 0;
  let ttsCalls = 0;
  const originalFetch = globalThis.fetch;
  const harness = await startPttAudioHarness({
    providerEnabled: true,
    mockRealtime: true,
    realtimeFetcher: async () => {
      realtimeCalls += 1;
      return Response.json({ value: 'bai-eph-local-test', expires_at: Math.floor(Date.now() / 1000) + 120 });
    },
    ttsFetcher: async (_url, options) => {
      ttsCalls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.input, FIXED_AUTHORED_LINE.text);
      assert.equal(body.voice, 'chloe');
      return new Response('stubbed provider failure', { status: 503 });
    },
  });
  context.after(() => harness.close());
  await assert.rejects(startPttAudioHarness({ providerEnabled: true, mockRealtime: true }), /Only one mocked Realtime harness/);
  const origin = new URL(harness.url).origin;
  const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const events = await fetch(new URL('/boson-dialogue', harness.url));
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  await reader.read(); // connected comment

  const begin = await fetch(new URL('/boson-ptt/begin', harness.url), { method: 'POST', headers });
  assert.equal(begin.status, 200);
  const turn = await begin.json();
  assert.deepEqual(turn.allowedLineIds, ['mira-greeting']);
  assert.equal(turn.maxHoldMs, 30_000);
  assert.equal(realtimeCalls, 1);

  const complete = await fetch(new URL('/boson-ptt/complete', harness.url), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId: turn.turnId, response: { playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' } }),
  });
  assert.equal(complete.status, 200);
  assert.equal((await complete.json()).status, 'accepted');
  const eventChunk = await reader.read();
  const eventText = new TextDecoder().decode(eventChunk.value);
  assert.match(eventText, /event: dialogue/);
  assert.match(eventText, /mira-greeting/);

  const tts = await fetch(new URL('/boson-tts', harness.url), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: `audio-test-${turn.turnId}`, speakerId: 'mira' }),
  });
  assert.equal(tts.status, 502);
  assert.equal(ttsCalls, 1);
  const usage = await fetch(new URL('/harness/status', harness.url)).then((response) => response.json());
  assert.equal(usage.usage.realtimeTurns, 1);
  assert.equal(usage.usage.tts.requests, 1);
  assert.equal(usage.usage.tts.characters, FIXED_AUTHORED_LINE.text.length);
  await reader.cancel();
  await harness.close();
  assert.equal(globalThis.fetch, originalFetch, 'closing the harness restores the process fetch transport');
});
