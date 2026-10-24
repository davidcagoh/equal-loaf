import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createIpcServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPttServer } from './viewer-ptt-server.ts';

test('no-resident PTT failure guides the player toward a live resident without starting audio', async () => {
  const originalKey = process.env.BOSON_API_KEY;
  const originalEnvFile = process.env.BOSON_PTT_ENV_FILE;
  const originalSocketPath = process.env.BOSON_VILLAGE_IPC_SOCKET;
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'boson-ptt-encounter-'));
  const socketPath = join(directory, 'village.sock');
  const guidance = 'No resident is within 8 blocks. Walk 7 blocks southeast toward Anna, then try again.';
  let providerCalls = 0;
  let ptt: ReturnType<typeof createPttServer> | undefined;
  const ipcServer = createIpcServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const command = JSON.parse(buffer.slice(0, newline)) as { turnId: string };
      socket.end(`${JSON.stringify({
        version: 1, type: 'ptt.ack', phase: 'begin', turnId: command.turnId,
        status: 'no_resident', guidance,
      })}\n`);
    });
  });
  const httpServer = createHttpServer();
  delete process.env.BOSON_PTT_ENV_FILE;
  process.env.BOSON_API_KEY = 'synthetic-test-key';
  process.env.BOSON_VILLAGE_IPC_SOCKET = socketPath;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error('Provider fetch must not occur for no-resident precondition failure');
  }) as typeof fetch;

  try {
    await new Promise<void>((resolve, reject) => {
      ipcServer.once('error', reject);
      ipcServer.listen(socketPath, resolve);
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    ptt = createPttServer(port);
    httpServer.on('request', (request, response) => {
      if (!ptt?.handleRequest(request, response)) response.writeHead(404).end();
    });

    const origin = `http://127.0.0.1:${port}`;
    const response = await originalFetch(`${origin}/boson-ptt/begin`, {
      method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
    });
    const result = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 409);
    assert.equal(result.error, guidance);
    assert.equal(providerCalls, 0);
  } finally {
    ptt?.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => ipcServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.BOSON_API_KEY;
    else process.env.BOSON_API_KEY = originalKey;
    if (originalEnvFile === undefined) delete process.env.BOSON_PTT_ENV_FILE;
    else process.env.BOSON_PTT_ENV_FILE = originalEnvFile;
    if (originalSocketPath === undefined) delete process.env.BOSON_VILLAGE_IPC_SOCKET;
    else process.env.BOSON_VILLAGE_IPC_SOCKET = originalSocketPath;
    globalThis.fetch = originalFetch;
  }
});
