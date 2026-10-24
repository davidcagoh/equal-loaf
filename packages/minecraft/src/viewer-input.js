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
  let status = document.querySelector('.camera-help');
  if (!status) {
    status = document.createElement('div');
    status.className = 'camera-help';
    status.setAttribute('role', 'status');
    document.body.append(status);
  }
  status.textContent = 'Connecting to viewer…';
  if (!canvas) return;
  canvas.tabIndex = 0;

  const socket = window.io();
  const buttons = Object.fromEntries(BUTTON_NAMES.map((name) => [name, false]));
  let seq = 0;
  let yaw = 0;
  let pitch = 0;
  let poseReady = false;
  let pointerLocked = false;
  let pointerLockPending = false;

  function hasViewerFocus() {
    return document.pointerLockElement === canvas
      || document.activeElement === canvas;
  }

  function updateStatus() {
    if (!socket.connected) {
      status.textContent = 'Viewer disconnected · reconnecting…';
    } else if (!poseReady) {
      status.textContent = 'Connected · waiting for player position…';
    } else if (pointerLocked) {
      status.textContent = 'WASD move · mouse look · Esc releases controls';
    } else if (document.activeElement === canvas) {
      status.textContent = 'WASD move · click for mouse look · Esc releases controls';
    } else {
      status.textContent = 'Click the world to play · WASD move · mouse look · Esc releases controls';
    }
  }

  socket.on('position', (packet) => {
    if (!packet?.pos || !Number.isFinite(packet.yaw) || !Number.isFinite(packet.pitch)) return;
    if (!pointerLocked) {
      yaw = packet.yaw;
      pitch = packet.pitch;
      window.bosonLookPose = { yaw, pitch };
    }
    poseReady = true;
    updateStatus();
  });

  function sendControls() {
    if (!hasViewerFocus() || !socket.connected || !poseReady) return;
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
    canvas.focus?.();
    updateStatus();
    if (!document.pointerLockElement && !pointerLockPending) {
      try {
        const lockRequest = canvas.requestPointerLock?.();
        if (lockRequest && typeof lockRequest.then === 'function') {
          pointerLockPending = true;
          void lockRequest.catch(() => undefined).finally(() => {
            pointerLockPending = false;
            updateStatus();
          });
        }
      } catch {
        updateStatus();
      }
    }
  }

  canvas.addEventListener('click', requestPointerLock);
  canvas.addEventListener('pointerdown', requestPointerLock);
  document.addEventListener('keydown', (event) => {
    const control = BUTTON_KEYS[event.code];
    if (!control || !hasViewerFocus()) return;
    event.preventDefault();
    buttons[control] = true;
  });
  document.addEventListener('keyup', (event) => {
    const control = BUTTON_KEYS[event.code];
    if (!control) return;
    buttons[control] = false;
    if (hasViewerFocus()) event.preventDefault();
  });
  document.addEventListener('mousemove', (event) => {
    if (!document.pointerLockElement || !poseReady) return;
    yaw = ((yaw - event.movementX * LOOK_SENSITIVITY + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch - event.movementY * LOOK_SENSITIVITY));
    window.bosonLookPose = { yaw, pitch };
  });
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    updateStatus();
    if (pointerLocked) sendControls();
    else releaseControls();
  });
  canvas.addEventListener('focus', updateStatus);
  canvas.addEventListener('blur', () => {
    updateStatus();
    if (!pointerLocked) releaseControls();
  });
  window.addEventListener('blur', releaseControls);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') releaseControls();
  });
  window.addEventListener('pagehide', releaseControls);
  socket.on('disconnect', () => {
    releaseControls();
    updateStatus();
  });
  socket.on('connect', () => {
    seq = 0;
    updateStatus();
  });
  updateStatus();
  window.setInterval(sendControls, LOOK_INTERVAL_MS);
}

if (typeof document !== 'undefined') startViewerInput();
