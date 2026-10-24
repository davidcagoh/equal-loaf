import { createRequire } from 'node:module';
import { once } from 'node:events';
import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { isVillageDialogue } from './viewer-audio.js';
import { isVillageResidentPositionsEvent, type VillageResidentPositionsEvent } from './village-event.ts';
import { createPttServer, isSameOriginPttRequest } from './viewer-ptt-server.ts';
import { createHiggsTtsHandler, RESIDENT_VOICES } from './audio/higgs-tts.js';
import type { Duplex } from 'node:stream';
import type { MineflayerBot } from './index.ts';

type ViewerStarter = (bot: object, options: { port: number }) => void;
type ViewerApi = { mineflayer: ViewerStarter };
type ViewerBot = MineflayerBot & {
  entity?: MineflayerBot['entity'] & { yaw?: number; pitch?: number };
  setControlState?: (control: string, state: boolean) => void;
  look?: (yaw: number, pitch: number, force?: boolean) => Promise<void>;
  viewer?: {
    close?: () => void;
    on?: (event: string, listener: (...args: unknown[]) => void) => void;
    emit?: (event: string, ...args: unknown[]) => void;
    removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  };
};

const CONTROL_NAMES = ['forward', 'back', 'left', 'right', 'jump', 'sprint'] as const;
type ControlName = typeof CONTROL_NAMES[number];
interface ExplorerControlPacket {
  type: 'explorer.control';
  seq: number;
  buttons: Record<ControlName, boolean>;
  yaw: number;
  pitch: number;
  at: number;
}

export function isExplorerControlPacket(value: unknown): value is ExplorerControlPacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const packet = value as Record<string, unknown>;
  if (Object.keys(packet).sort().join(',') !== 'at,buttons,pitch,seq,type,yaw'
    || packet.type !== 'explorer.control'
    || !Number.isSafeInteger(packet.seq) || (packet.seq as number) < 0
    || !Number.isFinite(packet.yaw) || Math.abs(packet.yaw as number) > Math.PI * 2
    || !Number.isFinite(packet.pitch)
    || !Number.isFinite(packet.at) || Math.abs(Date.now() - (packet.at as number)) > 5_000
    || !packet.buttons || typeof packet.buttons !== 'object' || Array.isArray(packet.buttons)) return false;
  const buttons = packet.buttons as Record<string, unknown>;
  return Object.keys(buttons).sort().join(',') === [...CONTROL_NAMES].sort().join(',')
    && CONTROL_NAMES.every((name) => typeof buttons[name] === 'boolean')
    && (packet.pitch as number) >= -Math.PI / 2 && (packet.pitch as number) <= Math.PI / 2;
}

export function applyExplorerControls(bot: ViewerBot): () => void {
  const viewer = bot.viewer;
  if (!viewer?.on || !bot.setControlState || !bot.look) return () => undefined;
  let activeSocketId: string | undefined;
  let lastSequence = -1;
  let lastPacketAt = 0;
  const clearControls = () => {
    for (const control of CONTROL_NAMES) bot.setControlState?.(control, false);
    activeSocketId = undefined;
    lastSequence = -1;
    lastPacketAt = 0;
  };
  const onControl = (...args: unknown[]) => {
    const [socketId, rawPacket] = args;
    if (typeof socketId !== 'string' || !isExplorerControlPacket(rawPacket)) return;
    const now = Date.now();
    if (activeSocketId && activeSocketId !== socketId && now - lastPacketAt <= 300) return;
    if (activeSocketId !== socketId) {
      clearControls();
      activeSocketId = socketId;
    }
    if (rawPacket.seq <= lastSequence || now - lastPacketAt < 20) return;
    lastSequence = rawPacket.seq;
    lastPacketAt = now;
    const buttons = rawPacket.buttons;
    for (const control of CONTROL_NAMES) bot.setControlState?.(control, buttons[control]);
    const yaw = ((rawPacket.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rawPacket.pitch));
    void bot.look?.(yaw, pitch, true).catch(() => undefined);
  };
  const onDisconnect = (...args: unknown[]) => {
    if (args[0] === activeSocketId) clearControls();
  };
  const onRelease = (...args: unknown[]) => {
    if (args[0] === activeSocketId) clearControls();
  };
  viewer.on('boson:controls', onControl);
  viewer.on('boson:control-release', onRelease);
  viewer.on('boson:control-disconnect', onDisconnect);
  const deadman = setInterval(() => {
    if (activeSocketId && Date.now() - lastPacketAt > 300) clearControls();
  }, 100);
  return () => {
    clearInterval(deadman);
    viewer.removeListener?.('boson:controls', onControl);
    viewer.removeListener?.('boson:control-release', onRelease);
    viewer.removeListener?.('boson:control-disconnect', onDisconnect);
    clearControls();
  };
}

const require = createRequire(import.meta.url);

function serveViewerSource(response: ServerResponse, source: URL, contentType: string): void {
  try {
    const content = readFileSync(source);
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' }).end(content);
  } catch {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      .end('Viewer audio module is unavailable.');
  }
}

function restrictViewerRequests(server: Server, port: number, pttServer: ReturnType<typeof createPttServer>, ttsServer: ReturnType<typeof createHiggsTtsHandler>, recentDialogue: Map<string, { eventId?: string; speakerId: string; lineId?: string; line: string }>): () => void {
  const viewerOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const documentOrigins = new Set([...viewerOrigins, 'http://127.0.0.1:8000', 'http://localhost:8000']);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const framePolicy = "frame-ancestors http://127.0.0.1:8000 http://localhost:8000";
  const originalEmit = server.emit;
  const dialogueClients = new Set<ServerResponse>();
  const residentClients = new Set<ServerResponse>();
  let latestResidentPositions: VillageResidentPositionsEvent | null = null;
  const viewerClients = new Set<Duplex>();
  const viewerIndex = readFileSync(require.resolve('prismarine-viewer/public/index.html'), 'utf8');
  const viewerPage = viewerIndex.replace('</body>', '<script src="/socket.io/socket.io.js"></script><script type="module" src="/boson-controls.js"></script><script type="module" src="/boson-audio.js"></script><script type="module" src="/boson-ptt.js"></script></body>');
  const nativeResidentViewerPage = viewerIndex.replace('</body>', '<script src="/socket.io/socket.io.js"></script><script type="module" src="/boson-controls.js"></script><script type="module" src="/boson-ptt-native.js"></script></body>');

  const routeDialogue = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (request.url?.split('?')[0] !== '/boson-dialogue') return false;
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.write(': connected\n\n');
      dialogueClients.add(response);
      response.once('close', () => dialogueClients.delete(response));
      return true;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'GET, POST' }).end();
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const event: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isVillageDialogue(event)) {
          response.writeHead(400).end('Invalid village dialogue event.');
          return;
        }
        recentDialogue.set(`${event.speakerId}:${event.eventId}`, event);
        while (recentDialogue.size > 512) recentDialogue.delete(recentDialogue.keys().next().value!);
        const data = `event: dialogue\ndata: ${JSON.stringify(event)}\n\n`;
        for (const client of dialogueClients) client.write(data);
        response.writeHead(202).end();
      } catch {
        response.writeHead(400).end('Invalid JSON dialogue event.');
      }
    });
    return true;
  };

  const routeResidentPositions = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (request.url?.split('?')[0] !== '/boson-residents') return false;
    if (request.method === 'GET') {
      const origin = request.headers.origin;
      const allowedHosts = new Set([...viewerOrigins].map((value) => new URL(value).host));
      if ((origin && !viewerOrigins.has(origin)) || request.headers['sec-fetch-site'] !== 'same-origin'
        || typeof request.headers.host !== 'string' || !allowedHosts.has(request.headers.host)) {
        response.writeHead(403).end('Same-origin viewer request required.');
        return true;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.write(': connected\n\n');
      residentClients.add(response);
      response.once('close', () => residentClients.delete(response));
      if (latestResidentPositions) response.write(`event: residents\ndata: ${JSON.stringify(latestResidentPositions)}\n\n`);
      return true;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'GET, POST' }).end();
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4_096) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const event: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isVillageResidentPositionsEvent(event)) {
          response.writeHead(400).end('Invalid resident positions event.');
          return;
        }
        latestResidentPositions = event;
        const data = `event: residents\ndata: ${JSON.stringify(event)}\n\n`;
        for (const client of residentClients) client.write(data);
        response.writeHead(202).end();
      } catch {
        response.writeHead(400).end('Invalid JSON resident positions event.');
      }
    });
    return true;
  };

  const allowed = (request: IncomingMessage, socketHandshake = false): boolean => {
    const host = request.headers.host;
    const origin = request.headers.origin;
    const origins = socketHandshake || request.url?.startsWith('/socket.io') ? viewerOrigins : documentOrigins;
    const path = request.url?.split('?')[0];
    const topLevelViewerNavigation = request.method === 'GET'
      && (path === '/' || path === '/index.html')
      && request.headers['sec-fetch-mode'] === 'navigate'
      && request.headers['sec-fetch-dest'] === 'document';
    return Boolean(host && allowedHosts.has(host)
      && (topLevelViewerNavigation || (!origin || origins.has(origin))
        && request.headers['sec-fetch-site'] !== 'cross-site'));
  };

  server.emit = function (eventName: string | symbol, ...args: unknown[]) {
    if (eventName === 'request') {
      const [request, response] = args as [IncomingMessage, ServerResponse];
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', framePolicy);
      if (!allowed(request)) {
        response.writeHead(403).end('Local viewer requests only.');
        return true;
      }
      if (routeDialogue(request, response)) return true;
      if (routeResidentPositions(request, response)) return true;
      if (request.url?.split('?')[0] === '/boson-tts') {
        if (!isSameOriginPttRequest(request, viewerOrigins)) {
          response.writeHead(403).end('Same-origin viewer request required.');
          return true;
        }
        void ttsServer.handleRequest(request, response);
        return true;
      }
      if (pttServer.handleRequest(request, response)) return true;
      if (request.method === 'GET' && request.url === '/boson-controls.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
          .end(readFileSync(new URL('./viewer-input.js', import.meta.url)));
        return true;
      }
      if (request.method === 'GET' && request.url === '/boson-ptt.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
          .end(readFileSync(new URL('./viewer-ptt.js', import.meta.url)));
        return true;
      }
      if (request.method === 'GET' && request.url === '/village-vocabulary.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
          .end(readFileSync(new URL('./village-vocabulary.js', import.meta.url)));
        return true;
      }
      if (request.method === 'GET' && request.url === '/boson-ptt-worklet.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
          .end(readFileSync(new URL('./viewer-ptt-worklet.js', import.meta.url)));
        return true;
      }
      if (request.method === 'GET' && (request.url?.split('?')[0] === '/' || request.url?.split('?')[0] === '/index.html')) {
        const nativeResidentAudio = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).searchParams.get('nativeResidentAudio') === '1';
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(nativeResidentAudio ? nativeResidentViewerPage : viewerPage);
        return true;
      }
      if (request.method === 'GET' && request.url === '/boson-ptt-native.js') {
        serveViewerSource(response, new URL('./viewer-ptt-native.js', import.meta.url), 'text/javascript; charset=utf-8');
        return true;
      }
      if (request.method === 'GET' && request.url === '/boson-audio.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
          .end(readFileSync(new URL('./viewer-audio.js', import.meta.url)));
        return true;
      }
      if (request.method === 'GET' && request.url === '/audio/spatial-voice-mixer.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
          .end(readFileSync(new URL('./audio/spatial-voice-mixer.js', import.meta.url)));
        return true;
      }
      if (request.method === 'GET' && request.url === '/audio/native-realtime-core.js') {
        serveViewerSource(response, new URL('./audio/native-realtime-core.js', import.meta.url), 'text/javascript; charset=utf-8');
        return true;
      }
      if (request.method === 'GET' && request.url === '/audio/native-resident-pcm-mixer.js') {
        serveViewerSource(response, new URL('./audio/native-resident-pcm-mixer.js', import.meta.url), 'text/javascript; charset=utf-8');
        return true;
      }
      if (request.method === 'GET' && request.url === '/audio/native-response-playback.js') {
        serveViewerSource(response, new URL('../../../boson-api-demo/native-response-playback.js', import.meta.url), 'text/javascript; charset=utf-8');
        return true;
      }
    }
    if (eventName === 'upgrade') {
      const [request, socket] = args as [IncomingMessage, Duplex];
      if (!allowed(request, true)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return true;
      }
      viewerClients.add(socket);
      socket.once('close', () => viewerClients.delete(socket));
    }
    return Reflect.apply(originalEmit, this, [eventName, ...args]);
  } as typeof server.emit;

  return () => {
    pttServer.close();
    ttsServer.close();
    for (const client of dialogueClients) client.end();
    dialogueClients.clear();
    for (const client of viewerClients) client.destroy();
    viewerClients.clear();
  };
}

export async function startLoopbackViewer(bot: object, port: number, start: ViewerStarter): Promise<() => Promise<void>> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('Viewer port is invalid');

  const originalListen = Server.prototype.listen;
  let viewerServer: Server | undefined;
  Server.prototype.listen = function (...args: Parameters<typeof originalListen>) {
    const [requestedPort, callback] = args;
    if (viewerServer) throw new Error('Prismarine viewer attempted to start multiple HTTP listeners');
    if (typeof callback !== 'function') throw new Error('Prismarine viewer used an unsupported HTTP listen signature');
    if (requestedPort === port) {
      viewerServer = this;
      return Reflect.apply(originalListen, this, [port, '127.0.0.1', callback]);
    }
    if (typeof requestedPort === 'object' && requestedPort !== null && requestedPort.port === port) {
      viewerServer = this;
      return Reflect.apply(originalListen, this, [{ ...requestedPort, host: '127.0.0.1' }, callback]);
    }
    throw new Error('Prismarine viewer attempted to listen on an unexpected port');
  } as typeof originalListen;

  try {
    start(bot, { port });
  } catch (error) {
    if (viewerServer?.listening) viewerServer.close();
    throw error;
  } finally {
    Server.prototype.listen = originalListen;
  }

  if (!viewerServer) throw new Error('Prismarine viewer did not start an HTTP listener');
  const server = viewerServer;
  const stopExplorerControls = applyExplorerControls(bot as ViewerBot);
  const pttServer = createPttServer(port);
  const recentDialogue = new Map<string, { eventId?: string; speakerId: string; lineId?: string; line: string }>();
  const ttsServer = createHiggsTtsHandler({
    isAllowedRequest: (request: IncomingMessage) => isSameOriginPttRequest(request, new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])),
    resolveUtterance: (eventId: string, speakerId: string) => {
      const event = recentDialogue.get(`${speakerId}:${eventId}`);
      if (!event?.lineId || RESIDENT_VOICES[speakerId as keyof typeof RESIDENT_VOICES] === undefined) return null;
      return { lineId: event.lineId, text: event.line, voice: RESIDENT_VOICES[speakerId as keyof typeof RESIDENT_VOICES] };
    },
  });
  const closeDialogueClients = restrictViewerRequests(server, port, pttServer, ttsServer, recentDialogue);
  try {
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      server.once('listening', onListening);
      server.once('error', onError);
    });
  } catch (error) {
    stopExplorerControls();
    closeDialogueClients();
    if (server.listening) server.close();
    throw error;
  }
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    stopExplorerControls();
    closeDialogueClients();
    const viewerClose = (bot as ViewerBot).viewer?.close;
    if (server.listening && viewerClose) {
      const closed = once(server, 'close');
      viewerClose();
      await closed;
      return;
    }
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

export function startPrismarineViewer(bot: MineflayerBot, port = 3000): Promise<() => Promise<void>> {
  const viewer = require('prismarine-viewer') as ViewerApi;
  return startLoopbackViewer(bot, port, viewer.mineflayer);
}
