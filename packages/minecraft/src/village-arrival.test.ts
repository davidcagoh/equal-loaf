import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { VILLAGE_WALKIN_POINT } from './village-arrival.ts';

test('walk-in target matches the safe village world spawn and keeps the opening cluster in range', () => {
  const positions = [
    { x: 73.6, y: 68.9, z: 11.6 },
    { x: 70.4, y: 70, z: 23.5 },
    { x: 71.5, y: 69, z: 9.5 },
  ];
  const spawnFunction = readFileSync(new URL('../../../config/minecraft/world-packs/boson-village-spawn/data/boson/function/village_spawn.mcfunction', import.meta.url), 'utf8');
  assert.match(spawnFunction, new RegExp(`^setworldspawn ${VILLAGE_WALKIN_POINT.x} ${VILLAGE_WALKIN_POINT.y} ${VILLAGE_WALKIN_POINT.z}$`, 'm'));
  assert.ok(positions.every(({ x, y, z }) => Math.hypot(x - VILLAGE_WALKIN_POINT.x, y - VILLAGE_WALKIN_POINT.y, z - VILLAGE_WALKIN_POINT.z) <= 12));
});
