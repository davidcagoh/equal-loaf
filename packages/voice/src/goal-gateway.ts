import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { GoalScheduler } from '../../scheduler/src/index.ts';
import { parseGoalProposal, type CompanionEvent, type Goal, type GoalResult } from '../../contracts/src/index.ts';

const allowedKinds = ['follow', 'stop', 'approach', 'gather', 'give', 'defend', 'retreat', 'report'] as const;
const maxBodyBytes = 16 * 1024;

export interface GoalGatewayOptions {
  execute: (goal: Goal, signal: AbortSignal) => Promise<GoalResult>;
  host?: string;
  port?: number;
  onEvent?: (event: unknown) => void;
  isReady?: () => boolean;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new RangeError('Request exceeds the 16 KB limit');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('Request must be a JSON object');
  return parsed as Record<string, unknown>;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(data);
}

/** Local loopback bridge from the voice demo into the typed, cancellable scheduler. */
export function createGoalGateway(options: GoalGatewayOptions): { server: Server; scheduler: GoalScheduler } {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new TypeError('Goal gateway must bind to a loopback address');
  }
  const events: CompanionEvent[] = [];
  const scheduler = new GoalScheduler(options.execute, (event) => {
    events.push(event);
    if (events.length > 100) events.shift();
    options.onEvent?.(event);
  });
  const isReady = options.isReady ?? (() => true);
  const server = createServer(async (request, response) => {
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : (options.port ?? 8001);
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    const origin = request.headers.origin;
    if (!allowedHosts.has(request.headers.host ?? '')
      || (origin !== undefined && origin !== 'http://127.0.0.1:8000' && origin !== 'http://localhost:8000')
      || request.headers['sec-fetch-site'] === 'cross-site') {
      respond(response, 403, { error: 'Request origin is not allowed.' });
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      respond(response, 200, { ready: isReady() });
      return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      respond(response, 200, {
        ready: isReady(),
        objective: scheduler.objective ?? null,
        currentGoal: scheduler.currentGoal ?? null,
        queuedGoals: scheduler.queuedGoals,
        events,
      });
      return;
    }
    if (request.method !== 'POST' || !['/goals', '/stop'].includes(request.url ?? '')) {
      respond(response, 404, { error: 'Not found' });
      return;
    }
    try {
      if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
        throw new TypeError('Submit a JSON request');
      }
      if (request.url === '/stop') {
        const body = await readJson(request);
        if (Object.keys(body).length > 0) throw new TypeError('Stop request does not accept fields');
        const result = await scheduler.stop(`voice-stop-${randomUUID()}`);
        respond(response, result.status === 'completed' ? 200 : 503, {
          status: result.status,
          ...(result.detail ? { error: result.detail } : {}),
        });
        return;
      }
      if (!isReady()) {
        respond(response, 503, { error: 'Minecraft adapter is not connected; no goal was queued.' });
        return;
      }
      const body = await readJson(request);
      if (Object.keys(body).some((key) => !['kind', 'args'].includes(key))) {
        throw new TypeError('Only kind and args are accepted');
      }
      if (typeof body.kind !== 'string' || !(allowedKinds as readonly string[]).includes(body.kind)) {
        throw new TypeError('Goal kind is not supported');
      }
      const kind = body.kind as Goal['kind'];
      const goal = parseGoalProposal({
        id: `voice-${randomUUID()}`,
        kind,
        priority: kind === 'stop' ? 'emergency' : 'user',
        args: body.args ?? {},
        source: 'voice',
      });
      await scheduler.submit(goal);
      respond(response, 202, { goalId: goal.id, status: 'accepted' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respond(response, error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError ? 400 : 500, { error: message });
    }
  });
  server.listen(options.port ?? 8001, host);
  return { server, scheduler };
}
