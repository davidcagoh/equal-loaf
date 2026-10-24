import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_LIMITS, isAuthoredLineId, isWithinExplorerWatchRange, rendezvousExchange, shouldPauseForExplorer, VillageAi, VILLAGE_ACTIONS } from './village-ai.ts';

test('disabled AI makes no provider requests', async () => {
  let calls = 0;
  const ai = new VillageAi({ enabled: false, jevKey: 'fake', gatewayKey: 'fake', fetcher: async () => { calls += 1; throw new Error('unexpected'); } });
  assert.equal(await ai.chooseAction('mira', 'gardening'), null);
  assert.equal(await ai.planDialogue({ speaker: 'mira', listener: 'pip', activity: 'gardening', clueStage: 0, options: [{ id: 'ambient-0', line: 'Seedlings need water.' }] }, 'ambient-0'), 'ambient-0');
  assert.equal(calls, 0);
});

test('Jev accepts only whitelisted actions and logs usage without request content', async () => {
  const logs: string[] = [];
  let captured: RequestInit | undefined;
  const ai = new VillageAi({ enabled: true, jevKey: 'secret', fetcher: async (_url, init) => {
    captured = init;
    return Response.json({ model: 'jev-latest', answers: { action: { choice: 'attack' } }, usage: { input_tokens: 50, output_tokens: 2 } });
  }, log: (line) => logs.push(line) });
  assert.equal(await ai.chooseAction('mira', 'watering'), null);
  assert.equal(captured?.signal instanceof AbortSignal, true);
  assert.equal((captured?.headers as Record<string, string>).authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(logs[0] ?? '{}'), { type: 'village.ai_usage', provider: 'typesafe-jev', model: 'jev-latest', requests: 1,
    inputTokens: 50, outputTokens: 2, estimatedCostUsd: 0.0000021, outcome: 'ok', requestCounts: { jev: 1, gateway: 0 }, estimatedCostTotalUsd: 0.0000021, rateSnapshot: '2026-10-24 UTC', rateSource: 'typesafe.ai/blog/introducing-system-one-models-and-jev ($42/B input, output free)' });
  assert.equal(logs[0]?.includes('watering'), false);
});

test('Jev chosen action is from the exact enumerated set and request cap is hard', async () => {
  let calls = 0;
  const ai = new VillageAi({ enabled: true, jevKey: 'fake', fetcher: async () => { calls += 1; return Response.json({ model: 'jev-latest', answers: { action: { choice: 'idle' } }, usage: { input_tokens: 1, output_tokens: 1 } }); }, log: () => {} });
  assert.ok(VILLAGE_ACTIONS.includes(await ai.chooseAction('pip', 'baking', 10_000) as any));
  assert.equal(await ai.chooseAction('pip', 'baking', 10_001), null);
  for (let i = 1; i < AI_LIMITS.jevMaxRequests; i += 1) await ai.chooseAction('pip', 'baking', 10_000 + AI_LIMITS.jevMinIntervalMs * i);
  assert.equal(await ai.chooseAction('pip', 'baking', 10_000 + AI_LIMITS.jevMinIntervalMs * AI_LIMITS.jevMaxRequests), null);
  assert.equal(calls, AI_LIMITS.jevMaxRequests);
});

test('planner falls back for invalid dialogue and throttles requests', async () => {
  let calls = 0;
  const ai = new VillageAi({ enabled: true, gatewayKey: 'fake', fetcher: async () => { calls += 1; return Response.json({ model: 'openai/gpt-4.1-mini', choices: [{ message: { content: JSON.stringify({ lineId: 'I accuse you of murder.' }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }); }, log: () => {} });
  const input = { speaker: 'mira', listener: 'tobin', activity: 'gardening', clueStage: 1, options: [{ id: 'ambient-0', line: 'I saw a cart by the garden.' }] };
  assert.equal(await ai.planDialogue(input, 'ambient-0'), 'ambient-0');
  assert.equal(ai.plannerDue(), false);
  assert.equal(await ai.planDialogue(input, 'ambient-0'), 'ambient-0');
  assert.equal(calls, 1);
});

test('planner request is single-flight while a provider call is pending', async () => {
  let calls = 0;
  let release!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { release = resolve; });
  const ai = new VillageAi({ enabled: true, gatewayKey: 'fake', fetcher: async () => { calls += 1; return response; }, log: () => {} });
  const input = { speaker: 'tobin', listener: 'mira', activity: 'mapping', clueStage: 0, options: [{ id: 'ambient-3', line: 'The map rests near the river.' }] };
  const first = ai.planDialogue(input, 'Map line.');
  const second = ai.planDialogue(input, 'Second fallback.');
  assert.equal(calls, 1);
  assert.equal(await second, 'Second fallback.');
  release(Response.json({ model: 'openai/gpt-4.1-mini', choices: [{ message: { content: JSON.stringify({ lineId: 'ambient-3' }) } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }));
  assert.equal(await first, 'ambient-3');
});

test('village meetings gather only their two participants at the authored stop', async () => {
  const navigated: string[] = [];
  const target = { x: 5, y: 64, z: 2 };
  const positions = new Map<string, { x: number; y: number; z: number }>();
  const met = await rendezvousExchange('mira', 'pip', target, async (id, destination) => {
    navigated.push(id);
    positions.set(id, { ...destination });
  }, (id) => positions.get(id) ?? null);
  assert.equal(met, true);
  assert.deepEqual(navigated.sort(), ['mira', 'pip']);
  assert.equal(navigated.includes('tobin'), false);
});

test('explorer attention watches only at 3–6 blocks and pauses movement inside 3', () => {
  assert.equal(isWithinExplorerWatchRange(2.99), false);
  assert.equal(isWithinExplorerWatchRange(3), true);
  assert.equal(isWithinExplorerWatchRange(6), true);
  assert.equal(isWithinExplorerWatchRange(6.01), false);
  assert.equal(shouldPauseForExplorer(2.99), true);
  assert.equal(shouldPauseForExplorer(3), false);
  assert.equal(isAuthoredLineId('ambient-3', ['ambient-3']), true);
  assert.equal(isAuthoredLineId('new made-up accusation', ['ambient-3']), false);
});

test('cost remains unknown when token usage or the rate-matched model is missing', async () => {
  const logs: string[] = [];
  const ai = new VillageAi({ enabled: true, jevKey: 'fake', fetcher: async () => Response.json({ model: 'other-model', answers: { action: { choice: 'idle' } } }), log: (line) => logs.push(line) });
  assert.equal(await ai.chooseAction('mira', 'watering', 10_000), 'idle');
  const usage = JSON.parse(logs[0] ?? '{}');
  assert.equal(usage.model, 'other-model');
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
  assert.equal(usage.estimatedCostUsd, null);
});

test('versioned Jev model uses the dated Jev rate and logs usage', async () => {
  const logs: string[] = [];
  const ai = new VillageAi({ enabled: true, jevKey: 'fake', fetcher: async () => Response.json({ model: 'jev-1.14.0', answers: { action: { choice: 'idle' } }, usage: { input_tokens: 363, output_tokens: 58 } }), log: (line) => logs.push(line) });
  assert.equal(await ai.chooseAction('mira', 'watering', 10_000), 'idle');
  const usage = JSON.parse(logs[0] ?? '{}');
  assert.equal(usage.model, 'jev-1.14.0');
  assert.equal(usage.estimatedCostUsd, 0.00001525);
  assert.equal(usage.estimatedCostTotalUsd, 0.00001525);
});

test('provider HTTP failure is reported without provider response details', async () => {
  const logs: string[] = [];
  const ai = new VillageAi({ enabled: true, gatewayKey: 'fake', fetcher: async () => new Response('sensitive provider response', { status: 402 }), log: (line) => logs.push(line) });
  await ai.planDialogue({ speaker: 'mira', listener: 'pip', activity: 'watering', clueStage: 0, options: [{ id: 'ambient-0', line: 'The seedlings need rain.' }] }, 'ambient-0');
  const usage = JSON.parse(logs[0] ?? '{}');
  assert.equal(usage.outcome, 'fallback:provider_http_402');
  assert.equal(usage.estimatedCostUsd, null);
  assert.equal(logs.join('').includes('sensitive provider response'), false);
});
