/** Optional server-side AI boundary. All inputs are synthetic village state. */
export const VILLAGE_ACTIONS = ['walk_to', 'stop', 'look_at', 'turn_toward', 'idle'] as const;
export type VillageAction = typeof VILLAGE_ACTIONS[number];
export interface Usage { inputTokens: number; outputTokens: number; estimatedCostUsd: number | null }
export interface VillageAiConfig {
  enabled: boolean; jevKey?: string; gatewayKey?: string;
  fetcher?: typeof fetch; log?: (line: string) => void;
}
export const AI_LIMITS = Object.freeze({ jevMaxRequests: 12, jevMinIntervalMs: 10_000, gatewayMaxRequests: 3, maxInputBytes: 1_024, maxOutputBytes: 2_000, jevTimeoutMs: 1_500, gatewayTimeoutMs: 8_000 });
const JEV_INPUT_COST_PER_BILLION = 42;
const GATEWAY_INPUT_COST_PER_TOKEN = 0.0000004;
const GATEWAY_OUTPUT_COST_PER_TOKEN = 0.0000016;

function cost(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  return Number((inputTokens * inputRate + outputTokens * outputRate).toFixed(8));
}
function usageFrom(raw: any, inputRate: number, outputRate: number): Usage {
  const rawInputTokens = raw?.input_tokens ?? raw?.prompt_tokens;
  const rawOutputTokens = raw?.output_tokens ?? raw?.completion_tokens;
  if (rawInputTokens === undefined || rawOutputTokens === undefined) return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null };
  const inputTokens = Number(rawInputTokens);
  const outputTokens = Number(rawOutputTokens);
  const valid = Number.isFinite(inputTokens) && inputTokens >= 0 && Number.isFinite(outputTokens) && outputTokens >= 0;
  return valid ? { inputTokens, outputTokens, estimatedCostUsd: cost(inputTokens, outputTokens, inputRate, outputRate) } : { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null };
}
function isPricedJevModel(model: string): boolean {
  return model === 'jev-latest' || /^jev-\d+\.\d+\.\d+$/.test(model);
}
function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^HTTP \d{3}$/.test(error.message)) return `provider_http_${error.message.slice(-3)}`;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'provider_timeout';
  if (error instanceof TypeError || error instanceof SyntaxError) return 'invalid_provider_response';
  return 'provider_error';
}
function jsonObject(text: string, maxBytes = AI_LIMITS.maxOutputBytes): Record<string, any> {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new TypeError('provider output exceeded limit');
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('provider output must be an object');
  return parsed as Record<string, any>;
}
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new TypeError('provider response body missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new TypeError('provider output exceeded limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
export function isWithinExplorerWatchRange(distance: number): boolean { return distance >= 3 && distance <= 6; }
export function shouldPauseForExplorer(distance: number): boolean { return distance < 3; }
export function isAuthoredLineId(value: unknown, allowedIds: readonly string[]): value is string {
  return typeof value === 'string' && allowedIds.includes(value);
}
export interface VillagePoint { x: number; y: number; z: number }
export function distance3d(left: VillagePoint, right: VillagePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
export async function rendezvousExchange(
  speakerId: string, listenerId: string, target: VillagePoint,
  navigate: (residentId: string, target: VillagePoint) => Promise<void>,
  position: (residentId: string) => VillagePoint | null,
): Promise<boolean> {
  if (speakerId === listenerId) return false;
  await Promise.all([navigate(speakerId, target), navigate(listenerId, target)]);
  const speaker = position(speakerId);
  const listener = position(listenerId);
  return Boolean(speaker && listener && distance3d(speaker, target) <= 2 && distance3d(listener, target) <= 4);
}

export class VillageAi {
  private readonly fetcher: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly config: VillageAiConfig;
  private jevCount = 0;
  private gatewayCount = 0;
  private lastJevAt = 0;
  private lastPlannerAt = 0;
  private cumulativeCostUsd = 0;
  private costUnknown = false;
  constructor(config: VillageAiConfig) {
    this.config = config;
    this.fetcher = config.fetcher ?? fetch;
    this.log = config.log ?? ((line) => process.stderr.write(`${line}\n`));
  }
  plannerDue(now = Date.now()): boolean {
    return this.config.enabled && Boolean(this.config.gatewayKey) && this.gatewayCount < AI_LIMITS.gatewayMaxRequests && now - this.lastPlannerAt >= 60_000;
  }
  async chooseAction(resident: string, activity: string, now = Date.now()): Promise<VillageAction | null> {
    if (!this.config.enabled || !this.config.jevKey || this.jevCount >= AI_LIMITS.jevMaxRequests || now - this.lastJevAt < AI_LIMITS.jevMinIntervalMs) return null;
    if (Buffer.byteLength(resident) > 32 || Buffer.byteLength(activity) > 80) return null;
    this.lastJevAt = now;
    this.jevCount += 1;
    const request = { model: 'jev-latest', state: JSON.stringify({ resident, activity }), questions: { action: { type: 'choice', instructions: 'Choose one safe ordinary village behavior.', criteria: Object.fromEntries(VILLAGE_ACTIONS.map((item) => [item, item.replaceAll('_', ' ')])) } } };
    try {
      const response = await this.fetcher('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${this.config.jevKey}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(AI_LIMITS.jevTimeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await readBounded(response, 4_000);
      const data = jsonObject(text, 4_000);
      const action = data.answers?.action?.choice;
      const result = VILLAGE_ACTIONS.includes(action) ? action as VillageAction : null;
      const model = typeof data.model === 'string' ? data.model : 'unknown';
      const usage = usageFrom(data.usage, JEV_INPUT_COST_PER_BILLION / 1_000_000_000, 0);
      this.record('typesafe-jev', model, { ...usage, estimatedCostUsd: isPricedJevModel(model) ? usage.estimatedCostUsd : null });
      return result;
    } catch (error) { this.record('typesafe-jev', 'jev-latest', { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null }, `fallback:${safeFailureCode(error)}`); return null; }
  }
  async planDialogue(snapshot: { speaker: string; listener: string; activity: string; clueStage: number; options: readonly { id: string; line: string }[] }, fallbackId: string): Promise<string> {
    const now = Date.now();
    if (!this.plannerDue(now)) return fallbackId;
    if ([snapshot.speaker, snapshot.listener, snapshot.activity].some((item) => typeof item !== 'string') ||
      Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > AI_LIMITS.maxInputBytes || !Number.isSafeInteger(snapshot.clueStage) || snapshot.clueStage < 0 ||
      snapshot.options.length === 0 || snapshot.options.some(({ id, line }) => !id || !line)) return fallbackId;
    this.lastPlannerAt = now;
    this.gatewayCount += 1;
    const prompt = `Choose exactly one supplied authored line by id. Do not write or alter dialogue. Return JSON {"lineId":"..."}. Fictional state: ${JSON.stringify(snapshot)}`;
    try {
      const response = await this.fetcher('https://ai-gateway.vercel.sh/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${this.config.gatewayKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-4.1-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 80, temperature: 0.2, response_format: { type: 'json_object' } }), signal: AbortSignal.timeout(AI_LIMITS.gatewayTimeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await readBounded(response, 12_000);
      const data = jsonObject(text, 12_000);
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new TypeError('missing scene choice');
      const lineId = jsonObject(content, AI_LIMITS.maxOutputBytes).lineId;
      const allowedIds = snapshot.options.map(({ id }) => id);
      if (!isAuthoredLineId(lineId, allowedIds)) throw new TypeError('invalid authored line id');
      const model = typeof data.model === 'string' ? data.model : 'unknown';
      const usage = usageFrom(data.usage, GATEWAY_INPUT_COST_PER_TOKEN, GATEWAY_OUTPUT_COST_PER_TOKEN);
      this.record('vercel-ai-gateway', model, { ...usage, estimatedCostUsd: model === 'openai/gpt-4.1-mini' ? usage.estimatedCostUsd : null });
      return lineId;
    } catch (error) { this.record('vercel-ai-gateway', 'openai/gpt-4.1-mini', { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null }, `fallback:${safeFailureCode(error)}`); return fallbackId; }
  }
  private record(provider: string, model: string, usage: Usage, outcome = 'ok'): void {
    if (usage.estimatedCostUsd === null) this.costUnknown = true;
    else this.cumulativeCostUsd += usage.estimatedCostUsd;
    this.log(JSON.stringify({ type: 'village.ai_usage', provider, model, requests: 1, ...usage, outcome,
      requestCounts: this.requestCounts, estimatedCostTotalUsd: this.costUnknown ? null : Number(this.cumulativeCostUsd.toFixed(8)),
      rateSnapshot: '2026-10-24 UTC', rateSource: provider === 'typesafe-jev' ? 'typesafe.ai/blog/introducing-system-one-models-and-jev ($42/B input, output free)' : 'AI Gateway model-list metadata (2026-10-24 UTC; $0.0000004/input, $0.0000016/output)' }));
  }
  get requestCounts(): Readonly<{ jev: number; gateway: number }> { return { jev: this.jevCount, gateway: this.gatewayCount }; }
}
