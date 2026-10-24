import assert from 'node:assert/strict';
import test from 'node:test';

interface ListenerEvent {
  code?: string;
  target?: unknown;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  preventDefault(): void;
}

test('movement works when the canvas has focus even if embedded pointer lock is unavailable', async () => {
  const documentListeners = new Map<string, Array<(event: ListenerEvent) => void>>();
  const windowListeners = new Map<string, Array<() => void>>();
  const canvasListeners = new Map<string, Array<() => void>>();
  const socketListeners = new Map<string, Array<(packet?: unknown) => void>>();
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const intervals: Array<() => void> = [];
  const status = { className: '', textContent: '' };
  const appended: unknown[] = [];
  const canvas = {
    focus() { document.activeElement = canvas; },
    addEventListener(name: string, listener: () => void) {
      canvasListeners.set(name, [...(canvasListeners.get(name) ?? []), listener]);
    },
    requestPointerLock() {},
  };
  const document = {
    activeElement: undefined as unknown,
    pointerLockElement: null as unknown,
    visibilityState: 'visible',
    body: { append(element: unknown) { appended.push(element); } },
    querySelector(selector: string) { return selector === 'canvas' ? canvas : selector === '.camera-help' ? status : null; },
    createElement() { return status; },
    addEventListener(name: string, listener: (event: ListenerEvent) => void) {
      documentListeners.set(name, [...(documentListeners.get(name) ?? []), listener]);
    },
  };
  const socket = {
    connected: true,
    on(name: string, listener: (packet?: unknown) => void) {
      socketListeners.set(name, [...(socketListeners.get(name) ?? []), listener]);
    },
    emit(event: string, payload?: unknown) { emitted.push({ event, payload }); },
  };
  const window = {
    io: () => socket,
    addEventListener(name: string, listener: () => void) {
      windowListeners.set(name, [...(windowListeners.get(name) ?? []), listener]);
    },
    setInterval(callback: () => void) { intervals.push(callback); return intervals.length; },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  try {
    await import('./viewer-input.js?embedded-focus-test');
    assert.equal(appended.length, 0, 'the existing viewer status element should be reused');
    socketListeners.get('position')?.forEach((listener) => listener({ pos: {}, yaw: 0, pitch: 0 }));
    canvasListeners.get('click')?.forEach((listener) => listener());

    const keydown = documentListeners.get('keydown')?.[0];
    const keyup = documentListeners.get('keyup')?.[0];
    assert.ok(keydown);
    assert.ok(keyup);
    const moveDown: ListenerEvent = { code: 'KeyW', target: canvas, preventDefault() {} };
    keydown(moveDown);
    intervals[0]?.();
    const downPacket = emitted.filter(({ event }) => event === 'boson:controls').at(-1)?.payload as {
      buttons: { forward: boolean };
    } | undefined;
    assert.equal(downPacket?.buttons.forward, true);

    keyup({ code: 'KeyW', target: canvas, preventDefault() {} });
    intervals[0]?.();
    const upPacket = emitted.filter(({ event }) => event === 'boson:controls').at(-1)?.payload as {
      buttons: { forward: boolean };
    } | undefined;
    assert.equal(upPacket?.buttons.forward, false);

    const input = { tagName: 'INPUT' };
    document.activeElement = input;
    keydown({ code: 'KeyW', target: input, preventDefault() {} });
    intervals[0]?.();
    const ignoredInputPacket = emitted.filter(({ event }) => event === 'boson:controls').at(-1)?.payload as {
      buttons: { forward: boolean };
    } | undefined;
    assert.equal(ignoredInputPacket?.buttons.forward, false);

    document.activeElement = canvas;
    keydown({ code: 'KeyW', target: canvas, preventDefault() {} });
    intervals[0]?.();
    const pressedPacket = emitted.filter(({ event }) => event === 'boson:controls').at(-1)?.payload as {
      buttons: { forward: boolean };
    } | undefined;
    assert.equal(pressedPacket?.buttons.forward, true);
    windowListeners.get('blur')?.forEach((listener) => listener());
    intervals[0]?.();
    const blurRelease = emitted.filter(({ event }) => event === 'boson:control-release').at(-1);
    const blurPacket = emitted.filter(({ event }) => event === 'boson:controls').at(-1)?.payload as {
      buttons: { forward: boolean };
    } | undefined;
    assert.ok(blurRelease);
    assert.equal(blurPacket?.buttons.forward, false);

    socket.connected = false;
    socketListeners.get('disconnect')?.forEach((listener) => listener());
    assert.match(status.textContent, /Viewer disconnected/);
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'window');
  }
});
