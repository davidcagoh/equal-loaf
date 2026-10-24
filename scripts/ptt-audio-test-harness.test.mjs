import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { FIXED_AUTHORED_LINE, FIXED_RESIDENT, startPttAudioHarness } from './ptt-audio-test-harness.mjs';

function requestWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject);
    request.end();
  });
}

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
  assert.match(page, /two deliberate held turns/i);
  assert.match(page, /96 characters/);
  assert.match(page, /No Minecraft world/);
  assert.doesNotMatch(page, /<iframe\b/i);
  assert.match(page, /id="run-controls" hidden/);
  assert.match(page, /id="enable-audio"[^>]*>Enable audio</);
  assert.match(page, /<details id="diagnostics"/);
  assert.match(page, /P or the talk button/i);
  assert.match(page, /deriveAudioBenchOutcome/);
  assert.match(page, /ptt-response-rejected/);
  assert.doesNotMatch(page, /Reply audio enabled for this tab/);

  for (const asset of [
    '/boson-ptt.js',
    '/boson-audio.js',
    '/ptt-audio-test-view.js',
    '/ptt-native-audio.js',
    '/native-response-playback.js',
    '/boson-ptt-worklet.js',
    '/village-vocabulary.js',
    '/audio/spatial-voice-mixer.js',
  ]) {
    const response = await fetch(new URL(asset, harness.url));
    assert.equal(response.status, 200, `${asset} should be served`);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
    if (asset === '/boson-ptt.js') {
      const script = await response.text();
      assert.match(script, /Hold P to talk/);
      assert.match(script, /document\.addEventListener\('keydown'/);
      assert.match(script, /Microphone permission was denied or blocked/);
      assert.match(script, /response_text_multiple_parts/);
      assert.match(script, /appendBoundedPttText/);
    }
    if (asset === '/ptt-native-audio.js') {
      assert.match(await response.text(), /from '\.\/native-response-playback\.js'/);
    }
    if (asset === '/native-response-playback.js') {
      const moduleSource = await response.text();
      assert.match(moduleSource, /createNativeResponsePlayback/);
      assert.match(moduleSource, /calculatePlayedAudioEndMs/);
    }
  }

  const statusResponse = await fetch(new URL('/harness/status', harness.url));
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.deepEqual(status.fixture, { speakerId: 'mira', speakerName: 'Anna', lineId: 'mira-greeting' });
  assert.equal(status.limits.realtimeTurns, 2);
  assert.equal(status.limits.maxHoldMs, 30_000);
  assert.equal(status.limits.ttsRequests, 2);
  assert.equal(status.limits.ttsCharacters, 96);
  assert.equal(status.usage.realtimeTurns, 0);
  assert.equal(status.usage.tts.requests, 0);
  assert.equal(status.usage.tts.actualProviderUsage, null);
  assert.deepEqual(FIXED_RESIDENT.facts, ['The garden is growing well today.', 'The east beds need watering.']);
  assert.ok(FIXED_AUTHORED_LINE.text.length <= status.limits.ttsCharacters);
  assert.equal(status.limits.estimatedTtsUsdMax, 0.00144);
  assert.deepEqual(FIXED_RESIDENT.responseOptions.map(({ lineId }) => lineId), ['mira-greeting', 'mira-garden-help']);

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
  assert.equal(secondBegin.status, 503, 'the second allowed turn is blocked because the provider is disabled');
  const thirdBegin = await fetch(new URL('/boson-ptt/begin', harness.url), {
    method: 'POST',
    headers: { Origin: localOrigin, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(thirdBegin.status, 429, 'the two-turn cap rejects later attempts');
  assert.deepEqual(await thirdBegin.json(), { available: false, error: 'This isolated test allows two Realtime turns.' });
  const afterBegin = await fetch(new URL('/harness/status', harness.url)).then((response) => response.json());
  assert.equal(afterBegin.usage.realtimeTurns, 2);

  const blockedTts = await fetch(new URL('/boson-tts', harness.url), {
    method: 'POST',
    headers: { Origin: 'http://example.invalid', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: 'fixture-1', speakerId: 'mira' }),
  });
  assert.equal(blockedTts.status, 403);
  const afterBlockedTts = await fetch(new URL('/harness/status', harness.url)).then((response) => response.json());
  assert.equal(afterBlockedTts.usage.tts.requests, 0);
});

test('mocked provider flow discriminates two public intents and caps cumulative TTS without network access', async (context) => {
  let realtimeCalls = 0;
  let ttsCalls = 0;
  const ttsInputs = [];
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
      ttsInputs.push(body.input);
      assert.ok(['Hello. The garden is growing well today.', 'Please water the east beds.'].includes(body.input));
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
  assert.deepEqual(turn.allowedLineIds, ['mira-greeting', 'mira-garden-help']);
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
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const secondBegin = await fetch(new URL('/boson-ptt/begin', harness.url), { method: 'POST', headers });
  assert.equal(secondBegin.status, 200);
  const secondTurn = await secondBegin.json();
  const secondComplete = await fetch(new URL('/boson-ptt/complete', harness.url), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId: secondTurn.turnId, response: { playerIntent: 'ask_for_help', topic: 'garden', lineId: 'mira-garden-help' } }),
  });
  assert.equal(secondComplete.status, 200);
  assert.equal((await secondComplete.json()).status, 'accepted');
  const secondEventText = new TextDecoder().decode((await reader.read()).value);
  assert.match(secondEventText, /mira-garden-help/);
  const secondTts = await fetch(new URL('/boson-tts', harness.url), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: `audio-test-${secondTurn.turnId}`, speakerId: 'mira' }),
  });
  assert.equal(secondTts.status, 502);
  assert.equal(ttsCalls, 2);
  assert.deepEqual(ttsInputs, ['Hello. The garden is growing well today.', 'Please water the east beds.']);
  const thirdBegin = await fetch(new URL('/boson-ptt/begin', harness.url), { method: 'POST', headers });
  assert.equal(thirdBegin.status, 429, 'the two-turn cap rejects a third request');
  const usage = await fetch(new URL('/harness/status', harness.url)).then((response) => response.json());
  assert.equal(usage.usage.realtimeTurns, 2);
  assert.equal(usage.usage.tts.requests, 2);
  assert.equal(usage.usage.tts.characters, 67);
  assert.deepEqual(usage.usage.lastTurn, {
    status: 'authored_response_selected', playerIntent: 'ask_for_help', topic: 'garden', lineId: 'mira-garden-help',
  });
  assert.deepEqual(usage.usage.turnResults, [
    { turnNumber: 1, status: 'authored_response_selected', playerIntent: 'greet', topic: 'general', lineId: 'mira-greeting' },
    { turnNumber: 2, status: 'authored_response_selected', playerIntent: 'ask_for_help', topic: 'garden', lineId: 'mira-garden-help' },
  ]);
  await reader.cancel();
  await harness.close();
  assert.equal(globalThis.fetch, originalFetch, 'closing the harness restores the process fetch transport');
});

test('native speech-to-speech session broker is local-only and keeps the API key server-side', async (context) => {
  const disabled = await startPttAudioHarness({ providerEnabled: false });
  context.after(() => disabled.close());
  const page = await fetch(new URL('/native', disabled.url));
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /Native Higgs Realtime speech-to-speech/);
  assert.match(pageText, /Hold P to talk/);
  assert.match(pageText, /chloe/);
  assert.doesNotMatch(pageText, /two short tests|96 characters|TTS requests/);
  const topLevelPage = await requestWithHeaders(new URL('/native', disabled.url), {
    'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none',
  });
  assert.equal(topLevelPage.status, 200);
  const untrustedNavigation = await requestWithHeaders(new URL('/native', disabled.url), {
    Origin: 'chrome-extension://sample',
    'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none',
  });
  assert.equal(untrustedNavigation.status, 403);
  const blockedDetail = untrustedNavigation.body;
  assert.match(blockedDetail, /host=allowed; origin=other; fetchSite=none; mode=navigate; dest=document/);
  assert.doesNotMatch(blockedDetail, /chrome-extension/);
  const forgedHostNavigation = await requestWithHeaders(new URL('/native', disabled.url), {
    Host: 'attacker.invalid',
    'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none',
  });
  assert.equal(forgedHostNavigation.status, 403);
  assert.match(forgedHostNavigation.body, /host=other/);
  const denied = await fetch(new URL('/native/session/start', disabled.url), {
    method: 'POST', headers: { Origin: new URL(disabled.url).origin, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).available, false);
});

test('Equal Loaf story tester lists three isolated residents and is safe while the provider is disabled', async (context) => {
  const harness = await startPttAudioHarness({ providerEnabled: false });
  context.after(() => harness.close());
  const page = await fetch(new URL('/native-story', harness.url));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Equal Loaf native conversation tester/);
  assert.match(html, /equal-loaf-context-v1/);
  assert.match(html, /Anna/);
  assert.match(html, /James/);
  assert.match(html, /Thomas/);
  assert.match(html, /Hold P to talk/);
  assert.match(html, /End conversations/);
  assert.doesNotMatch(html, /The garden is growing well today|east beds need watering/);

  const headers = { Origin: new URL(harness.url).origin, 'Sec-Fetch-Site': 'same-origin' };
  const residentsResponse = await fetch(new URL('/native/story/residents', harness.url), { headers });
  assert.equal(residentsResponse.status, 200);
  const residents = await residentsResponse.json();
  assert.deepEqual(residents.residents.map(({ residentId, name, voice }) => ({ residentId, name, voice })), [
    { residentId: 'mira', name: 'Anna', voice: 'chloe' },
    { residentId: 'tobin', name: 'James', voice: 'oliver' },
    { residentId: 'pip', name: 'Thomas', voice: 'jake' },
  ]);
  const invalid = await fetch(new URL('/native/story/session/start', harness.url), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ residentId: 'unknown' }),
  });
  assert.equal(invalid.status, 400);
  const disabled = await fetch(new URL('/native/story/session/start', harness.url), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ residentId: 'mira' }),
  });
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).available, false);
});

test('story credentials use the shared resident prompt builder with private per-resident facts and voices', async (context) => {
  let providerCalls = 0;
  const harness = await startPttAudioHarness({
    providerEnabled: true,
    mockRealtime: true,
    realtimeFetcher: async () => {
      providerCalls += 1;
      return Response.json({ value: `bai-eph-story-${providerCalls}`, expires_at: Math.floor(Date.now() / 1_000) + 300 });
    },
  });
  context.after(() => harness.close());
  const headers = { Origin: new URL(harness.url).origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  const start = async (residentId) => fetch(new URL('/native/story/session/start', harness.url), {
    method: 'POST', headers, body: JSON.stringify({ residentId }),
  });
  const annaResponse = await start('mira');
  assert.equal(annaResponse.status, 200);
  const anna = await annaResponse.json();
  assert.equal(anna.name, 'Anna');
  assert.equal(anna.voice, 'chloe');
  assert.match(anna.instructions, /garden workers/);
  assert.match(anna.instructions, /Speak and think freely/);
  assert.doesNotMatch(anna.instructions, /household map/);
  const duplicateAnna = await start('mira');
  assert.equal(duplicateAnna.status, 409, 'one selected resident keeps one live conversation in the map');

  const jamesResponse = await start('tobin');
  assert.equal(jamesResponse.status, 200);
  const james = await jamesResponse.json();
  assert.equal(james.name, 'James');
  assert.equal(james.voice, 'oliver');
  assert.match(james.instructions, /map count gives one share/);
  assert.doesNotMatch(james.instructions, /garden workers/);
  assert.notEqual(anna.residentSessionId, james.residentSessionId);
  const annaHeartbeat = await fetch(new URL(`/native/story/session/heartbeat?sessionId=${encodeURIComponent(anna.sessionId)}`, harness.url), {
    method: 'POST', headers,
  });
  assert.equal(annaHeartbeat.status, 200, 'switching to James leaves Anna’s separate session active');
  const endAnna = await fetch(new URL(`/native/story/session/end?sessionId=${encodeURIComponent(anna.sessionId)}`, harness.url), {
    method: 'POST', headers,
  });
  assert.equal(endAnna.status, 200);
  assert.equal((await fetch(new URL(`/native/story/session/heartbeat?sessionId=${encodeURIComponent(james.sessionId)}`, harness.url), {
    method: 'POST', headers,
  })).status, 200, 'ending Anna leaves James active');
  const restartedAnna = await start('mira');
  assert.equal(restartedAnna.status, 200);
  assert.notEqual((await restartedAnna.json()).residentSessionId, anna.residentSessionId);
  assert.equal(providerCalls, 3);
});

test('native session issues one ephemeral secret per active conversation and permits restart after stop', async (context) => {
  let calls = 0;
  const harness = await startPttAudioHarness({
    mockRealtime: true,
    realtimeFetcher: async () => {
      calls += 1;
      return Response.json({ value: 'bai-eph-native-test', expires_at: Math.floor(Date.now() / 1000) + 300 });
    },
  });
  context.after(() => harness.close());
  const origin = new URL(harness.url).origin;
  const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const start = () => fetch(new URL('/native/session/start', harness.url), { method: 'POST', headers });
  const firstResponse = await start();
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.available, true);
  assert.equal(first.clientSecret, 'bai-eph-native-test');
  assert.equal(Object.hasOwn(first, 'apiKey'), false);
  const overlapping = await start();
  assert.equal(overlapping.status, 409);
  assert.equal(calls, 1);
  const heartbeat = await fetch(new URL(`/native/session/heartbeat?sessionId=${encodeURIComponent(first.sessionId)}`, harness.url), {
    method: 'POST', headers,
  });
  assert.equal(heartbeat.status, 200);
  assert.deepEqual(await heartbeat.json(), { active: true });
  const stopped = await fetch(new URL(`/native/session/end?sessionId=${encodeURIComponent(first.sessionId)}`, harness.url), {
    method: 'POST', headers,
  });
  assert.equal(stopped.status, 200);
  const restarted = await start();
  assert.equal(restarted.status, 200);
  assert.equal(calls, 2);
});
