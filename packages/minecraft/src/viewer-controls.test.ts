import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { applyExplorerControls, isExplorerControlPacket } from './viewer.ts';
import { isSameOriginPttRequest } from './viewer-ptt-server.ts';

function packet(overrides: Record<string, unknown> = {}) {
  return {
    type: 'explorer.control',
    seq: 1,
    buttons: { forward: true, back: false, left: false, right: false, jump: false, sprint: false },
    yaw: 0.5,
    pitch: -0.2,
    at: Date.now(),
    ...overrides,
  };
}

test('control packets require the exact bounded button and pose schema', () => {
  assert.equal(isExplorerControlPacket(packet()), true);
  assert.equal(isExplorerControlPacket(packet({ yaw: 9 })), false);
  assert.equal(isExplorerControlPacket(packet({ pitch: Math.PI })), false);
  assert.equal(isExplorerControlPacket(packet({ at: Date.now() - 6_000 })), false);
  assert.equal(isExplorerControlPacket(packet({ buttons: { forward: true } })), false);
  assert.equal(isExplorerControlPacket(packet({ position: { x: 1, y: 2, z: 3 } })), false);
});

test('PTT routes require an explicit allowed Origin and same-origin fetch metadata', () => {
  const origins = new Set(['http://127.0.0.1:3000']);
  const request = (origin?: string, site?: string) => ({ headers: {
    ...(origin ? { origin } : {}),
    ...(site ? { 'sec-fetch-site': site } : {}),
  } }) as never;
  assert.equal(isSameOriginPttRequest(request('http://127.0.0.1:3000', 'same-origin'), origins), true);
  assert.equal(isSameOriginPttRequest(request('http://evil.example', 'same-origin'), origins), false);
  assert.equal(isSameOriginPttRequest(request('http://127.0.0.1:3000', 'cross-site'), origins), false);
  assert.equal(isSameOriginPttRequest(request(undefined, 'same-origin'), origins), false);
});

test('controls are owned by one socket lease and clear on release, disconnect, and deadman expiry', async () => {
  const viewer = new EventEmitter();
  const calls: Array<[string, boolean]> = [];
  const looks: Array<[number, number]> = [];
  const bot = {
    viewer,
    setControlState: (name: string, value: boolean) => calls.push([name, value]),
    look: async (yaw: number, pitch: number) => { looks.push([yaw, pitch]); },
  };
  const stop = applyExplorerControls(bot as never);
  viewer.emit('boson:controls', 'socket-a', packet());
  assert.equal(calls.some(([name, value]) => name === 'forward' && value), true);
  assert.deepEqual(looks, [[0.5, -0.2]]);

  viewer.emit('boson:controls', 'socket-b', packet({ seq: 2 }));
  assert.equal(calls.filter(([name, value]) => name === 'forward' && value).length, 1);
  viewer.emit('boson:control-release', 'socket-a');
  assert.equal(calls.at(-6)?.[1], false);

  viewer.emit('boson:controls', 'socket-b', packet({ seq: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(calls.at(-6)?.[1], false);
  viewer.emit('boson:controls', 'socket-c', packet({ seq: 1 }));
  viewer.emit('boson:control-disconnect', 'socket-c');
  assert.equal(calls.at(-6)?.[1], false);
  stop();
});
