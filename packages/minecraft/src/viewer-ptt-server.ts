import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PLAYER_INTENTS, VILLAGE_TOPICS } from './village-vocabulary.js';

const REALTIME_CLIENT_SECRETS_URL = 'https://api.boson.ai/v1/realtime/client_secrets';
const REALTIME_SECRET_TTL_SECONDS = 300;
const MAX_TURNS_PER_RUN = 10;
const MIN_BEGIN_INTERVAL_MS = 1_000;
const TURN_TTL_MS = 90_000;
const MAX_IPC_LINE_BYTES = 8_192;
const IPC_TIMEOUT_MS = 3_000;
const MAX_CONTEXT_BYTES = 4_000;
const MAX_MODEL_OUTPUT_BYTES = 2_000;
const ALLOWED_INTENTS: ReadonlySet<string> = new Set(PLAYER_INTENTS);
const ALLOWED_TOPICS: ReadonlySet<string> = new Set(VILLAGE_TOPICS);

interface PttResidentContext {
  id: string;
  name: string;
  role: string;
  goal: string;
  locationId: string;
  topics: string[];
  facts: string[];
  responseOptions: Array<{ lineId: string; summary: string; allowedIntents: string[]; topics: string[] }>;
  relationship: string;
}

interface PttBeginAck {
  version: 1;
  type: 'ptt.ack';
  phase: 'begin';
  turnId: string;
  status: 'ready';
  resident: PttResidentContext;
}

interface PttModelResponse {
  playerIntent: string;
  topic: string;
  lineId: string;
}

interface ActiveTurn {
  residentId: string;
  responseOptions: PttResidentContext['responseOptions'];
  expires: ReturnType<typeof setTimeout>;
}

interface PttServer {
  handleRequest(request: IncomingMessage, response: ServerResponse): boolean;
  close(): void;
}

function readBosonApiKey(): string | undefined {
  const environmentFile = process.env.BOSON_PTT_ENV_FILE;
  if (environmentFile) {
    try { process.loadEnvFile(environmentFile); } catch { /* missing local env file keeps PTT unavailable */ }
  }
  return process.env.BOSON_API_KEY?.trim() || undefined;
}

function objectHasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function safeString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

export function isPttBeginAck(value: unknown, turnId: string): value is PttBeginAck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ack = value as Record<string, unknown>;
  if (!objectHasExactKeys(ack, ['version', 'type', 'phase', 'turnId', 'status', 'resident'])
    || ack.version !== 1 || ack.type !== 'ptt.ack' || ack.phase !== 'begin'
    || ack.turnId !== turnId || ack.status !== 'ready'
    || !ack.resident || typeof ack.resident !== 'object' || Array.isArray(ack.resident)) return false;
  const resident = ack.resident as Record<string, unknown>;
  if (!objectHasExactKeys(resident, ['id', 'name', 'role', 'goal', 'locationId', 'topics', 'facts', 'responseOptions', 'relationship'])
    || !safeString(resident.id, 64) || !safeString(resident.name, 80)
    || !safeString(resident.role, 80) || !safeString(resident.goal, 200) || !safeString(resident.locationId, 80)
    || !safeString(resident.relationship, 160)
    || !Array.isArray(resident.topics) || resident.topics.length > 12
    || !Array.isArray(resident.facts) || resident.facts.length > 12
    || !Array.isArray(resident.responseOptions) || resident.responseOptions.length === 0 || resident.responseOptions.length > 32
    || !resident.topics.every((topic) => safeString(topic, 80))
    || !resident.facts.every((fact) => safeString(fact, 200))) return false;
  const options = resident.responseOptions as unknown[];
  if (!options.every((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const option = raw as Record<string, unknown>;
    return objectHasExactKeys(option, ['lineId', 'summary', 'allowedIntents', 'topics'])
      && safeString(option.lineId, 128) && /^[A-Za-z0-9:_.-]+$/.test(option.lineId)
      && safeString(option.summary, 160)
      && Array.isArray(option.allowedIntents) && option.allowedIntents.length > 0 && option.allowedIntents.length <= 8
      && option.allowedIntents.every((intent) => typeof intent === 'string' && ALLOWED_INTENTS.has(intent))
      && Array.isArray(option.topics) && option.topics.length > 0 && option.topics.length <= 12
      && option.topics.every((topic) => typeof topic === 'string' && ALLOWED_TOPICS.has(topic));
  })) return false;
  const ids = options.map((raw) => (raw as Record<string, unknown>).lineId);
  if (new Set(ids).size !== ids.length) return false;
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_CONTEXT_BYTES;
}

export function isPttModelResponse(value: unknown, turn: Pick<ActiveTurn, 'responseOptions'>): value is PttModelResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return objectHasExactKeys(response, ['playerIntent', 'topic', 'lineId'])
    && typeof response.playerIntent === 'string' && ALLOWED_INTENTS.has(response.playerIntent)
    && typeof response.topic === 'string' && ALLOWED_TOPICS.has(response.topic)
    && typeof response.lineId === 'string' && turn.responseOptions.some((option) => option.lineId === response.lineId
      && option.allowedIntents.includes(response.playerIntent) && option.topics.includes(response.topic))
    && Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_MODEL_OUTPUT_BYTES;
}

function buildResidentInstructions(context: PttResidentContext): string {
  const allowedLineIds = context.responseOptions.map(({ lineId }) => lineId);
  const prompt = [
    `You are ${context.name}, a ${context.role} in a friendly Minecraft village.`,
    `Your ordinary goal: ${context.goal}`,
    `Public topics: ${context.topics.join('; ') || 'everyday village life'}`,
    `Public facts: ${context.facts.join('; ') || 'No extra public facts.'}`,
    `Your relationship with the explorer: ${context.relationship}`,
    'Listen to the held push-to-talk turn. Do not quote or repeat the speaker. Do not disclose private clues, hidden story truth, suspicions, or anything outside the public facts above. Do not claim a new world event happened. You cannot control the game or call tools.',
    `Choose a playerIntent from ${PLAYER_INTENTS.join(', ')} and a topic from ${VILLAGE_TOPICS.join(', ')}.`,
    `Choose only an authored response compatible with those values: ${context.responseOptions.map(({ lineId, allowedIntents, topics }) => `${lineId} [intents: ${allowedIntents.join(', ')}; topics: ${topics.join(', ')}]`).join('; ')}.`,
    'Return only a JSON object with exactly these string fields: playerIntent, topic, lineId. Do not include a transcript or generated dialogue text.',
  ].join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_CONTEXT_BYTES) throw new TypeError('Village context exceeded the prompt limit');
  return prompt;
}

function requestVillageIpc(event: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socketPath = process.env.BOSON_VILLAGE_IPC_SOCKET;
  if (!socketPath) return Promise.reject(new Error('Village voice bridge is unavailable'));
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_IPC_LINE_BYTES) return Promise.reject(new Error('Village voice event exceeded the local limit'));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Village voice bridge timed out')), IPC_TIMEOUT_MS);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error('Village voice bridge returned no response'));
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_IPC_LINE_BYTES) {
        finish(new Error('Village voice bridge response exceeded the local limit'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const value: unknown = JSON.parse(buffer.slice(0, newline));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid bridge response');
        finish(undefined, value as Record<string, unknown>);
      } catch {
        finish(new Error('Village voice bridge returned an invalid response'));
      }
    });
    socket.once('error', () => finish(new Error('Village voice bridge is unavailable')));
    socket.once('end', () => {
      if (!settled) finish(new Error('Village voice bridge closed before acknowledging the turn'));
    });
  });
}

function respond(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }).end(JSON.stringify(payload));
}

export function isSameOriginPttRequest(request: IncomingMessage, viewerOrigins: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  if (origin) return viewerOrigins.has(origin) && request.headers['sec-fetch-site'] === 'same-origin';
  const allowedHosts = new Set([...viewerOrigins].map((value) => new URL(value).host));
  return request.method === 'GET'
    && request.url?.split('?')[0] === '/boson-ptt/status'
    && typeof request.headers.host === 'string' && allowedHosts.has(request.headers.host)
    && request.headers['sec-fetch-site'] === 'same-origin';
}

function readSmallJson(request: IncomingMessage, limit = 1_024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new TypeError('Request body exceeded the local limit'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new TypeError('Request body is invalid JSON'));
      }
    });
    request.once('error', () => reject(new TypeError('Request body could not be read')));
  });
}

export function createPttServer(port: number): PttServer {
  const apiKey = readBosonApiKey();
  const activeTurns = new Map<string, ActiveTurn>();
  let turnsUsed = 0;
  let lastBeginAt = 0;
  let beginInFlight = false;
  let closed = false;
  const viewerOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const removeTurn = (turnId: string): ActiveTurn | undefined => {
    const turn = activeTurns.get(turnId);
    if (turn) {
      clearTimeout(turn.expires);
      activeTurns.delete(turnId);
    }
    return turn;
  };

  const cancelTurn = async (turnId: string, turn?: ActiveTurn): Promise<void> => {
    removeTurn(turnId);
    if (!turn) return;
    await requestVillageIpc({ version: 1, type: 'ptt.cancel', turnId, at: Date.now() }).catch(() => undefined);
  };

  const createSecret = async (): Promise<{ clientSecret: string; expiresAt: number }> => {
    if (!apiKey) throw new Error('Boson voice is not configured');
    const result = await fetch(REALTIME_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expires_after: { seconds: REALTIME_SECRET_TTL_SECONDS } }),
      signal: AbortSignal.timeout(8_000),
    });
    const payload: unknown = await result.json();
    if (!result.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Boson voice could not start');
    const secret = payload as Record<string, unknown>;
    if (typeof secret.value !== 'string' || !secret.value.startsWith('bai-eph-')
      || !Number.isSafeInteger(secret.expires_at) || (secret.expires_at as number) <= Math.floor(Date.now() / 1_000)) {
      throw new Error('Boson voice returned an invalid session credential');
    }
    return { clientSecret: secret.value, expiresAt: secret.expires_at as number };
  };

  const begin = async (response: ServerResponse): Promise<void> => {
    if (!apiKey) {
      respond(response, 503, { available: false, error: 'Boson voice is not configured; local village audio remains available.' });
      return;
    }
    if (!process.env.BOSON_VILLAGE_IPC_SOCKET) {
      respond(response, 503, { available: false, error: 'Village voice bridge is unavailable; local village audio remains available.' });
      return;
    }
    const now = Date.now();
    if (closed || beginInFlight || turnsUsed >= MAX_TURNS_PER_RUN || now - lastBeginAt < MIN_BEGIN_INTERVAL_MS) {
      respond(response, 429, { available: false, error: 'Push-to-talk turn limit reached; local village audio remains available.' });
      return;
    }
    beginInFlight = true;
    lastBeginAt = now;
    const turnId = randomUUID();
    let turn: ActiveTurn | undefined;
    let counted = false;
    try {
      const ack = await requestVillageIpc({ version: 1, type: 'ptt.begin', turnId, at: Date.now() });
      if (!isPttBeginAck(ack, turnId)) {
        if (ack.status === 'no_resident') {
          const guidance = safeString(ack.guidance, 240)
            ? ack.guidance
            : 'No resident is within 8 blocks. Walk toward a villager and try again when you are closer.';
          respond(response, 409, { available: false, error: guidance });
          return;
        }
        respond(response, 503, { available: false, error: 'A nearby villager is unavailable; local village audio remains available.' });
        return;
      }
      turnsUsed += 1;
      counted = true;
      const instructions = buildResidentInstructions(ack.resident);
      const credential = await createSecret();
      turn = {
        residentId: ack.resident.id,
        responseOptions: ack.resident.responseOptions,
        expires: setTimeout(() => { void cancelTurn(turnId, turn); }, TURN_TTL_MS),
      };
      activeTurns.set(turnId, turn);
      respond(response, 200, {
        available: true,
        turnId,
        allowedLineIds: ack.resident.responseOptions.map(({ lineId }) => lineId),
        clientSecret: credential.clientSecret,
        expiresAt: credential.expiresAt,
        instructions,
        outputTokenLimit: 160,
        maxHoldMs: 30_000,
      });
    } catch {
      if (turn) await cancelTurn(turnId, turn);
      else if (counted) await requestVillageIpc({ version: 1, type: 'ptt.cancel', turnId, at: Date.now() }).catch(() => undefined);
      respond(response, 503, { available: false, error: 'Boson voice could not start; local village audio remains available.' });
    } finally {
      beginInFlight = false;
    }
  };

  const complete = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let body: unknown;
    try {
      body = await readSmallJson(request);
    } catch {
      respond(response, 400, { accepted: false, error: 'Invalid push-to-talk response.' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      respond(response, 400, { accepted: false, error: 'Invalid push-to-talk response.' });
      return;
    }
    const payload = body as Record<string, unknown>;
    if (!objectHasExactKeys(payload, ['turnId', 'response']) || typeof payload.turnId !== 'string') {
      respond(response, 400, { accepted: false, error: 'Invalid push-to-talk response.' });
      return;
    }
    const turn = activeTurns.get(payload.turnId);
    if (!turn) {
      respond(response, 410, { accepted: false, error: 'Push-to-talk turn expired.' });
      return;
    }
    const selectedResponse = isPttModelResponse(payload.response, turn) ? payload.response : null;
    removeTurn(payload.turnId);
    try {
      const ack = await requestVillageIpc({
        version: 1,
        type: 'ptt.complete',
        turnId: payload.turnId,
        response: selectedResponse,
        at: Date.now(),
      });
      if (ack.version !== 1 || ack.type !== 'ptt.ack' || ack.phase !== 'complete' || ack.turnId !== payload.turnId) {
        respond(response, 502, { accepted: false, error: 'Village could not finish the turn; local village audio remains available.' });
        return;
      }
      respond(response, 200, { accepted: ack.status === 'accepted' || ack.status === 'fallback', status: ack.status });
    } catch {
      respond(response, 503, { accepted: false, error: 'Village could not finish the turn; local village audio remains available.' });
    }
  };

  const cancel = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let body: unknown;
    try {
      body = await readSmallJson(request);
    } catch {
      respond(response, 400, { cancelled: false, error: 'Invalid push-to-talk cancellation.' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      respond(response, 400, { cancelled: false, error: 'Invalid push-to-talk cancellation.' });
      return;
    }
    const payload = body as Record<string, unknown>;
    if (!objectHasExactKeys(payload, ['turnId']) || typeof payload.turnId !== 'string') {
      respond(response, 400, { cancelled: false, error: 'Invalid push-to-talk cancellation.' });
      return;
    }
    const turn = activeTurns.get(payload.turnId);
    if (!turn) {
      respond(response, 410, { cancelled: false, error: 'Push-to-talk turn expired.' });
      return;
    }
    try {
      const ack = await requestVillageIpc({ version: 1, type: 'ptt.cancel', turnId: payload.turnId, at: Date.now() });
      removeTurn(payload.turnId);
      respond(response, 200, { cancelled: ack.phase === 'cancel' && ack.turnId === payload.turnId });
    } catch {
      removeTurn(payload.turnId);
      respond(response, 503, { cancelled: false, error: 'Village voice bridge is unavailable.' });
    }
  };

  return {
    handleRequest(request, response) {
      const pathname = request.url?.split('?')[0];
      if (!pathname?.startsWith('/boson-ptt/')) return false;
      if (!isSameOriginPttRequest(request, viewerOrigins)) {
        respond(response, 403, { available: false, error: 'Local viewer requests only.' });
        return true;
      }
      if (pathname === '/boson-ptt/status' && request.method === 'GET') {
        const available = Boolean(apiKey && process.env.BOSON_VILLAGE_IPC_SOCKET) && turnsUsed < MAX_TURNS_PER_RUN && !closed;
        respond(response, 200, {
          available,
          remainingTurns: Math.max(0, MAX_TURNS_PER_RUN - turnsUsed),
          message: !apiKey ? 'Push-to-talk is unavailable. Local village audio remains available.'
            : !process.env.BOSON_VILLAGE_IPC_SOCKET ? 'Village voice bridge is unavailable. Local village audio remains available.'
              : available ? 'Hold to talk to the nearest villager.' : 'Push-to-talk turn limit reached. Local village audio remains available.',
        });
        return true;
      }
      if (request.method !== 'POST') {
        respond(response, 405, { available: false, error: 'Method not allowed.' });
        return true;
      }
      if (pathname === '/boson-ptt/begin') {
        void begin(response);
        return true;
      }
      if (pathname === '/boson-ptt/complete') {
        void complete(request, response);
        return true;
      }
      if (pathname === '/boson-ptt/cancel') {
        void cancel(request, response);
        return true;
      }
      respond(response, 404, { available: false, error: 'Not found.' });
      return true;
    },
    close() {
      closed = true;
      for (const [turnId, turn] of activeTurns) {
        clearTimeout(turn.expires);
        void requestVillageIpc({ version: 1, type: 'ptt.cancel', turnId, at: Date.now() }).catch(() => undefined);
      }
      activeTurns.clear();
    },
  };
}
