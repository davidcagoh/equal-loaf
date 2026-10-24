import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PLAYER_INTENTS, VILLAGE_TOPICS } from './village-vocabulary.js';
import { buildNativeResidentInstructions } from './native-resident-context.ts';
import { RESIDENT_VOICES } from './audio/higgs-tts.js';

const REALTIME_CLIENT_SECRETS_URL = 'https://api.boson.ai/v1/realtime/client_secrets';
const REALTIME_SECRET_TTL_SECONDS = 300;
const MAX_TURNS_PER_RUN = 10;
const MIN_BEGIN_INTERVAL_MS = 1_000;
const TURN_TTL_MS = 90_000;
const MAX_IPC_LINE_BYTES = 8_192;
const IPC_TIMEOUT_MS = 3_000;
const MAX_CONTEXT_BYTES = 4_000;
const MAX_MODEL_OUTPUT_BYTES = 2_000;
const MAX_NATIVE_SESSION_IDS = 8;
const MAX_NATIVE_HEARD_SPEECH = 3;
const MAX_NATIVE_HEARD_TEXT_BYTES = 1_000;
const MAX_NATIVE_TRANSCRIPT_BYTES = 1_000;
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
  recentHeardSpeech?: Array<{ eventId: string; speakerId: string; speakerName: string; text: string; tick: number }>;
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
  residentSessionId?: string;
  native?: boolean;
  credentialIssued?: boolean;
  credentialIssueInFlight?: boolean;
  responseOptions: PttResidentContext['responseOptions'];
  expires: ReturnType<typeof setTimeout>;
}

interface ResidentSessionBinding {
  id: string;
  residentId: string;
}

interface NativeBeginRequest {
  knownResidentSessionIds: string[];
}

interface NativeSpeechPayload {
  turnId: string;
  residentSessionId: string;
  responseId: string;
  itemId: string;
  playback?: 'completed' | 'interrupted';
  transcript?: string;
}

export interface NativePlayerSpeechPayload {
  turnId: string;
  residentSessionId: string;
  itemId: string;
  transcript: string;
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
  const baseResidentKeys = ['id', 'name', 'role', 'goal', 'locationId', 'topics', 'facts', 'responseOptions', 'relationship'];
  const residentKeys = Object.hasOwn(resident, 'recentHeardSpeech') ? [...baseResidentKeys, 'recentHeardSpeech'] : baseResidentKeys;
  if (!objectHasExactKeys(resident, residentKeys)
    || !safeString(resident.id, 64) || !safeString(resident.name, 80)
    || !safeString(resident.role, 80) || !safeString(resident.goal, 200) || !safeString(resident.locationId, 80)
    || !safeString(resident.relationship, 160)
    || !Array.isArray(resident.topics) || resident.topics.length > 12
    || !Array.isArray(resident.facts) || resident.facts.length > 12
    || !Array.isArray(resident.responseOptions) || resident.responseOptions.length > 32
    || !resident.topics.every((topic) => safeString(topic, 80))
    || !resident.facts.every((fact) => safeString(fact, 200))) return false;
  if (Object.hasOwn(resident, 'recentHeardSpeech')) {
    if (!Array.isArray(resident.recentHeardSpeech) || resident.recentHeardSpeech.length > MAX_NATIVE_HEARD_SPEECH
      || !resident.recentHeardSpeech.every((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const heard = raw as Record<string, unknown>;
        return objectHasExactKeys(heard, ['eventId', 'speakerId', 'speakerName', 'text', 'tick'])
          && safeString(heard.eventId, 180) && safeString(heard.speakerId, 64)
          && safeString(heard.speakerName, 80)
          && safeString(heard.text, 1_000) && Buffer.byteLength(heard.text, 'utf8') <= MAX_NATIVE_HEARD_TEXT_BYTES
          && Number.isSafeInteger(heard.tick) && (heard.tick as number) >= 0;
      })) return false;
  }
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

export function isNativeBeginRequest(value: unknown): value is NativeBeginRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !objectHasExactKeys(value as Record<string, unknown>, ['knownResidentSessionIds'])) return false;
  const ids = (value as Record<string, unknown>).knownResidentSessionIds;
  return Array.isArray(ids) && ids.length <= MAX_NATIVE_SESSION_IDS
    && ids.every((id) => safeString(id, 64) && /^[A-Za-z0-9_-]+$/.test(id))
    && new Set(ids).size === ids.length;
}

export function isNativePlayerSpeechPayload(value: unknown): value is NativePlayerSpeechPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !objectHasExactKeys(value as Record<string, unknown>, ['turnId', 'residentSessionId', 'itemId', 'transcript'])) return false;
  const payload = value as Record<string, unknown>;
  return safeString(payload.turnId, 128) && /^[A-Za-z0-9_-]+$/.test(payload.turnId)
    && safeString(payload.residentSessionId, 64) && /^[A-Za-z0-9_-]+$/.test(payload.residentSessionId)
    && safeString(payload.itemId, 160) && /^[A-Za-z0-9_.:-]+$/.test(payload.itemId)
    && safeString(payload.transcript, MAX_NATIVE_TRANSCRIPT_BYTES)
    && Buffer.byteLength(payload.transcript, 'utf8') <= MAX_NATIVE_TRANSCRIPT_BYTES;
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

async function readNativeSpeechPayload(
  request: IncomingMessage,
  response: ServerResponse,
  phase: 'start' | 'finish',
): Promise<NativeSpeechPayload | null> {
  let body: unknown;
  try { body = await readSmallJson(request, 4_096); } catch {
    respond(response, 400, { accepted: false, error: 'Invalid native speech event.' });
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    respond(response, 400, { accepted: false, error: 'Invalid native speech event.' });
    return null;
  }
  const payload = body as Record<string, unknown>;
  const keys = Object.keys(payload).sort().join(',');
  const startKeys = ['itemId', 'residentSessionId', 'responseId', 'turnId'].sort().join(',');
  const finishKeys = [
    'itemId', 'residentSessionId', 'responseId', 'turnId', 'playback',
    ...(payload.playback === 'completed' && Object.hasOwn(payload, 'transcript') ? ['transcript'] : []),
  ].sort().join(',');
  if (keys !== (phase === 'start' ? startKeys : finishKeys)
    || !safeString(payload.turnId, 128) || !/^[A-Za-z0-9_-]+$/.test(payload.turnId)
    || !safeString(payload.residentSessionId, 64) || !/^[A-Za-z0-9_-]+$/.test(payload.residentSessionId)
    || !safeString(payload.responseId, 160) || !/^[A-Za-z0-9_.:-]+$/.test(payload.responseId)
    || !safeString(payload.itemId, 160) || !/^[A-Za-z0-9_.:-]+$/.test(payload.itemId)
    || (phase === 'finish' && payload.playback !== 'completed' && payload.playback !== 'interrupted')) {
    respond(response, 400, { accepted: false, error: 'Invalid native speech event.' });
    return null;
  }
  if (phase === 'finish') {
    const hasTranscript = Object.hasOwn(payload, 'transcript');
    if (payload.playback === 'interrupted' && hasTranscript) {
      respond(response, 400, { accepted: false, error: 'Interrupted speech cannot claim unheard words.' });
      return null;
    }
    if (payload.playback === 'completed' && (!hasTranscript || !safeString(payload.transcript, MAX_NATIVE_TRANSCRIPT_BYTES)
      || Buffer.byteLength(payload.transcript, 'utf8') > MAX_NATIVE_TRANSCRIPT_BYTES
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload.transcript))) {
      respond(response, 400, { accepted: false, error: 'Completed speech text is invalid.' });
      return null;
    }
  }
  return payload as unknown as NativeSpeechPayload;
}

export function createPttServer(port: number): PttServer {
  const apiKey = readBosonApiKey();
  const activeTurns = new Map<string, ActiveTurn>();
  const residentSessionByResident = new Map<string, ResidentSessionBinding>();
  const residentSessionById = new Map<string, ResidentSessionBinding>();
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

  const matchesNativeTurn = (turnId: string, residentSessionId: unknown): ActiveTurn | undefined => {
    const turn = activeTurns.get(turnId);
    const binding = residentSessionById.get(String(residentSessionId));
    return turn?.native && turn.residentSessionId === residentSessionId && binding?.residentId === turn.residentId
      ? turn : undefined;
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
      if (ack.resident.responseOptions.length === 0) {
        respond(response, 503, { available: false, error: 'No authored response is available for this turn.' });
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

  const nativeBegin = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!apiKey || !process.env.BOSON_VILLAGE_IPC_SOCKET) {
      respond(response, 503, { available: false, error: 'Village native voice is unavailable; local village audio remains available.' });
      return;
    }
    let body: unknown;
    try { body = await readSmallJson(request, 1_024); } catch {
      respond(response, 400, { available: false, error: 'Invalid native conversation request.' });
      return;
    }
    if (!isNativeBeginRequest(body)) {
      respond(response, 400, { available: false, error: 'Invalid native conversation request.' });
      return;
    }
    const now = Date.now();
    if (closed || beginInFlight || activeTurns.size >= 8 || turnsUsed >= MAX_TURNS_PER_RUN || now - lastBeginAt < MIN_BEGIN_INTERVAL_MS) {
      respond(response, 429, { available: false, error: 'Village conversation limit reached or another conversation is active.' });
      return;
    }
    beginInFlight = true;
    lastBeginAt = now;
    const turnId = randomUUID();
    let turn: ActiveTurn | undefined;
    try {
      const ack = await requestVillageIpc({ version: 1, type: 'ptt.native.begin', turnId, at: Date.now() });
      if (!isPttBeginAck(ack, turnId)) {
        if (ack.status === 'no_resident') {
          respond(response, 409, { available: false, error: safeString(ack.guidance, 240)
            ? ack.guidance : 'No resident is within 8 blocks. Walk toward a villager and try again.' });
          return;
        }
        respond(response, 503, { available: false, error: 'A nearby villager is unavailable.' });
        return;
      }

      const voice = RESIDENT_VOICES[ack.resident.id as keyof typeof RESIDENT_VOICES];
      if (!voice) {
        await requestVillageIpc({ version: 1, type: 'ptt.cancel', turnId, at: Date.now() }).catch(() => undefined);
        respond(response, 503, { available: false, error: 'A voice is not configured for this resident.' });
        return;
      }

      const existingSession = residentSessionByResident.get(ack.resident.id);
      const reuseSession = Boolean(existingSession && body.knownResidentSessionIds.includes(existingSession.id));
      const binding = reuseSession && existingSession
        ? existingSession
        : { id: randomUUID(), residentId: ack.resident.id };
      if (!reuseSession) {
        if (existingSession) residentSessionById.delete(existingSession.id);
        residentSessionByResident.set(binding.residentId, binding);
        residentSessionById.set(binding.id, binding);
      }

      const bindAck = await requestVillageIpc({
        version: 1, type: 'ptt.session.bind', turnId, residentSessionId: binding.id, at: Date.now(),
      });
      if (bindAck.type !== 'ptt.session.ack' || bindAck.turnId !== turnId || bindAck.status !== 'bound') {
        await requestVillageIpc({ version: 1, type: 'ptt.cancel', turnId, at: Date.now() }).catch(() => undefined);
        respond(response, 503, { available: false, error: 'Village could not bind the resident voice session.' });
        return;
      }

      turnsUsed += 1;
      turn = {
        residentId: ack.resident.id,
        residentSessionId: binding.id,
        native: true,
        credentialIssued: false,
        responseOptions: ack.resident.responseOptions,
        expires: setTimeout(() => { void cancelTurn(turnId, turn); }, TURN_TTL_MS),
      };
      activeTurns.set(turnId, turn);
      respond(response, 200, {
        available: true,
        turnId,
        residentSessionId: binding.id,
        residentId: ack.resident.id,
        speakerName: ack.resident.name,
        voice,
        reuseSession,
        instructions: buildNativeResidentInstructions(ack.resident),
        maxHoldMs: 30_000,
      });
    } catch {
      if (turn) await cancelTurn(turnId, turn);
      else await requestVillageIpc({ version: 1, type: 'ptt.cancel', turnId, at: Date.now() }).catch(() => undefined);
      respond(response, 503, { available: false, error: 'Village native voice could not start.' });
    } finally {
      beginInFlight = false;
    }
  };

  const nativeCredential = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let body: unknown;
    try { body = await readSmallJson(request, 512); } catch {
      respond(response, 400, { available: false, error: 'Invalid resident session request.' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !objectHasExactKeys(body as Record<string, unknown>, ['turnId', 'residentSessionId'])) {
      respond(response, 400, { available: false, error: 'Invalid resident session request.' });
      return;
    }
    const payload = body as Record<string, unknown>;
    const turn = typeof payload.turnId === 'string'
      ? matchesNativeTurn(payload.turnId, payload.residentSessionId) : undefined;
    if (!turn) {
      respond(response, 410, { available: false, error: 'Resident voice session expired.' });
      return;
    }
    if (turn.credentialIssued || turn.credentialIssueInFlight) {
      respond(response, 409, { available: false, error: 'Resident voice credential was already issued.' });
      return;
    }
    turn.credentialIssueInFlight = true;
    try {
      const credential = await createSecret();
      turn.credentialIssued = true;
      respond(response, 200, { available: true, clientSecret: credential.clientSecret, expiresAt: credential.expiresAt });
    } catch {
      respond(response, 503, { available: false, error: 'Resident voice could not connect.' });
    } finally {
      turn.credentialIssueInFlight = false;
    }
  };

  const nativeSpeechStart = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const payload = await readNativeSpeechPayload(request, response, 'start');
    if (!payload) return;
    const turn = matchesNativeTurn(payload.turnId, payload.residentSessionId);
    if (!turn) {
      respond(response, 410, { accepted: false, error: 'Resident voice turn expired.' });
      return;
    }
    try {
      const ack = await requestVillageIpc({ version: 1, type: 'ptt.speech.start', ...payload, at: Date.now() });
      respond(response, ack.type === 'ptt.speech.ack' && ack.turnId === payload.turnId && ack.status === 'started' ? 200 : 409,
        { accepted: ack.status === 'started', status: ack.status });
    } catch {
      respond(response, 503, { accepted: false, error: 'Village speech tracking is unavailable.' });
    }
  };

  const nativeSpeechFinish = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const payload = await readNativeSpeechPayload(request, response, 'finish');
    if (!payload) return;
    const turn = matchesNativeTurn(payload.turnId, payload.residentSessionId);
    if (!turn) {
      respond(response, 410, { accepted: false, error: 'Resident voice turn expired.' });
      return;
    }
    try {
      const ack = await requestVillageIpc({ version: 1, type: 'ptt.speech.finish', ...payload, at: Date.now() });
      const accepted = ack.type === 'ptt.speech.ack' && ack.turnId === payload.turnId && ack.status === 'finished';
      respond(response, accepted ? 200 : 409, { accepted, status: ack.status });
    } catch {
      respond(response, 503, { accepted: false, error: 'Village speech tracking is unavailable.' });
    }
  };

  const nativePlayerSpeechFinish = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let body: unknown;
    try { body = await readSmallJson(request, 2_048); } catch {
      respond(response, 400, { accepted: false, error: 'Invalid player speech transcript.' });
      return;
    }
    if (!isNativePlayerSpeechPayload(body)) {
      respond(response, 400, { accepted: false, error: 'Invalid player speech transcript.' });
      return;
    }
    const turn = matchesNativeTurn(body.turnId, body.residentSessionId);
    if (!turn) {
      respond(response, 410, { accepted: false, error: 'Resident voice turn expired.' });
      return;
    }
    try {
      const ack = await requestVillageIpc({ version: 1, type: 'ptt.player.speech.finish', ...body, at: Date.now() });
      const accepted = ack.type === 'ptt.player.speech.ack' && ack.turnId === body.turnId && ack.status === 'queued';
      respond(response, accepted ? 200 : 409, { accepted, status: ack.status });
    } catch {
      respond(response, 503, { accepted: false, error: 'Village speech tracking is unavailable.' });
    }
  };

  const nativeEnd = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let body: unknown;
    try { body = await readSmallJson(request, 512); } catch {
      respond(response, 400, { accepted: false, error: 'Invalid native conversation completion.' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !objectHasExactKeys(body as Record<string, unknown>, ['turnId', 'residentSessionId'])) {
      respond(response, 400, { accepted: false, error: 'Invalid native conversation completion.' });
      return;
    }
    const payload = body as Record<string, unknown>;
    const turn = typeof payload.turnId === 'string'
      ? matchesNativeTurn(payload.turnId, payload.residentSessionId) : undefined;
    if (!turn) {
      respond(response, 410, { accepted: false, error: 'Resident voice turn expired.' });
      return;
    }
    try {
      const ack = await requestVillageIpc({ version: 1, type: 'ptt.native.end', ...payload, at: Date.now() });
      removeTurn(String(payload.turnId));
      respond(response, ack.type === 'ptt.native.ack' && ack.turnId === payload.turnId && ack.status === 'ended' ? 200 : 409,
        { accepted: ack.status === 'ended', status: ack.status });
    } catch {
      removeTurn(String(payload.turnId));
      respond(response, 503, { accepted: false, error: 'Village conversation completion is unavailable.' });
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
      if (pathname === '/boson-ptt/native/begin') {
        void nativeBegin(request, response);
        return true;
      }
      if (pathname === '/boson-ptt/native/credential') {
        void nativeCredential(request, response);
        return true;
      }
      if (pathname === '/boson-ptt/speech/start') {
        void nativeSpeechStart(request, response);
        return true;
      }
      if (pathname === '/boson-ptt/speech/finish') {
        void nativeSpeechFinish(request, response);
        return true;
      }
      if (pathname === '/boson-ptt/player-speech/finish') {
        void nativePlayerSpeechFinish(request, response);
        return true;
      }
      if (pathname === '/boson-ptt/native/end') {
        void nativeEnd(request, response);
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
      residentSessionByResident.clear();
      residentSessionById.clear();
    },
  };
}
