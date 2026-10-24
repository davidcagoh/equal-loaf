import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { normalizeIndexSource } = require('../scripts/prismarine-viewer-patch.cjs') as {
  normalizeIndexSource(source: string): string;
};

test('patch normalization repairs a stale third-person viewer with duplicate declarations idempotently', () => {
  const stale = `/* global THREE */
const { Viewer, Entity } = require('../viewer')
const followCamera = require('./boson-follow-camera')
const FOLLOW_CAMERA_DISTANCE = 3.5
const CAMERA_COLLISION_RADIUS = 0.12
const CAMERA_COLLISION_CLEARANCE = 0.16
const followCamera = require('./boson-follow-camera')
const FOLLOW_CAMERA_DISTANCE = 3.5
const CAMERA_COLLISION_RADIUS = 0.12
const CAMERA_COLLISION_CLEARANCE = 0.16
const io = require('socket.io-client')
let firstPositionUpdate = true
let targetPose
let currentPose
let currentCameraDistance = 3.5
let previousFrameTime = performance.now()
let targetPose
let currentPose
let currentCameraDistance = 3.5
let previousFrameTime = performance.now()
const renderer = new THREE.WebGLRenderer()
function updateFollowCamera (deltaSeconds) {
  const safeDistance = FOLLOW_CAMERA_DISTANCE
}
function animate () {}
`;
  const repaired = normalizeIndexSource(stale);
  const repairedTwice = normalizeIndexSource(repaired);
  assert.equal(repairedTwice, repaired);
  assert.equal(repaired.match(/const followCamera =/g)?.length, 1);
  assert.equal(repaired.match(/let targetPose\n/g)?.length, 1);
  assert.equal(repaired.includes('currentCameraDistance = FOLLOW_CAMERA_DISTANCE'), false);
  assert.equal(repaired.includes('const safeDistance = FIRST_PERSON_DISTANCE'), true);
  assert.equal(repaired.includes('localLookPose'), true);
});
