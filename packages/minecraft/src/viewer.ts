import { createRequire } from 'node:module';
import { once } from 'node:events';
import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { MineflayerBot } from './index.ts';

type ViewerStarter = (bot: object, options: { port: number }) => void;
type ViewerApi = { mineflayer: ViewerStarter };
type ViewerBot = MineflayerBot & { viewer?: { close?: () => void } };

const require = createRequire(import.meta.url);

function restrictViewerRequests(server: Server, port: number): void {
  const viewerOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const documentOrigins = new Set([...viewerOrigins, 'http://127.0.0.1:8000', 'http://localhost:8000']);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const framePolicy = "frame-ancestors http://127.0.0.1:8000 http://localhost:8000";
  const originalEmit = server.emit;

  const allowed = (request: IncomingMessage, socketHandshake = false): boolean => {
    const host = request.headers.host;
    const origin = request.headers.origin;
    const origins = socketHandshake || request.url?.startsWith('/socket.io') ? viewerOrigins : documentOrigins;
    return Boolean(host && allowedHosts.has(host)
      && (!origin || origins.has(origin))
      && request.headers['sec-fetch-site'] !== 'cross-site');
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
    }
    if (eventName === 'upgrade') {
      const [request, socket] = args as [IncomingMessage, Duplex];
      if (!allowed(request, true)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return true;
      }
    }
    return Reflect.apply(originalEmit, this, [eventName, ...args]);
  } as typeof server.emit;
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
  restrictViewerRequests(server, port);
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
    if (server.listening) server.close();
    throw error;
  }
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
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
