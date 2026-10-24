const BUTTON_KEYS = Object.freeze({
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
});
const BUTTON_NAMES = Object.freeze(['forward', 'back', 'left', 'right', 'jump', 'sprint']);
const LOOK_SENSITIVITY = 0.0025;
const LOOK_INTERVAL_MS = 50;

export function startViewerInput() {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !window.io) return;
  const canvas = document.querySelector('canvas');
  const status = document.createElement('div');
  status.className = 'camera-help';
  status.textContent = 'Click the world to play · WASD move · mouse look · Esc releases controls';
  document.body.append(status);
  if (!canvas) return;

  const socket = window.io();
  const buttons = Object.fromEntries(BUTTON_NAMES.map((name) => [name, false]));
  let seq = 0;
  let yaw = 0;
  let pitch = 0;
  let poseReady = false;
  let pointerLocked = false;

  socket.on('position', (packet) => {
    if (!packet?.pos || !Number.isFinite(packet.yaw) || !Number.isFinite(packet.pitch)) return;
    if (!pointerLocked) {
      yaw = packet.yaw;
      pitch = packet.pitch;
      window.bosonLookPose = { yaw, pitch };
    }
    poseReady = true;
  });

  function sendControls() {
    if (!pointerLocked || !socket.connected || !poseReady) return;
    socket.emit('boson:controls', {
      type: 'explorer.control',
      seq: seq++,
      buttons: { ...buttons },
      yaw,
      pitch,
      at: Date.now(),
    });
  }

  function releaseControls() {
    for (const name of BUTTON_NAMES) buttons[name] = false;
    if (socket.connected) socket.emit('boson:control-release');
  }

  function requestPointerLock() {
    if (!document.pointerLockElement) void canvas.requestPointerLock?.();
  }

  canvas.addEventListener('click', requestPointerLock);
  canvas.addEventListener('pointerdown', requestPointerLock);
  document.addEventListener('keydown', (event) => {
    const control = BUTTON_KEYS[event.code];
    if (!control || !document.pointerLockElement) return;
    event.preventDefault();
    buttons[control] = true;
  });
  document.addEventListener('keyup', (event) => {
    const control = BUTTON_KEYS[event.code];
    if (!control) return;
    buttons[control] = false;
    if (document.pointerLockElement) event.preventDefault();
  });
  document.addEventListener('mousemove', (event) => {
    if (!document.pointerLockElement || !poseReady) return;
    yaw = ((yaw - event.movementX * LOOK_SENSITIVITY + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch - event.movementY * LOOK_SENSITIVITY));
    window.bosonLookPose = { yaw, pitch };
  });
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    status.textContent = document.pointerLockElement
      ? 'WASD move · mouse look · Esc releases controls'
      : 'Click the world to play · WASD move · mouse look · Esc releases controls';
    if (pointerLocked) sendControls();
    else releaseControls();
  });
  window.addEventListener('blur', releaseControls);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') releaseControls();
  });
  window.addEventListener('pagehide', releaseControls);
  socket.on('disconnect', releaseControls);
  socket.on('connect', () => { seq = 0; });
  window.setInterval(sendControls, LOOK_INTERVAL_MS);
}

if (typeof document !== 'undefined') startViewerInput();
