import assert from 'node:assert/strict';
import test from 'node:test';
import { villageProfiles } from './village-profiles.ts';

test('village actors have distinct identities, roles, and authored routines', () => {
  assert.equal(villageProfiles.length, 3);
  assert.equal(new Set(villageProfiles.map(({ username }) => username)).size, 3);
  assert.equal(new Set(villageProfiles.map(({ role }) => role)).size, 3);
  for (const profile of villageProfiles) {
    assert.match(profile.username, /^[A-Za-z0-9_]{3,16}$/);
    assert.ok(profile.lines.length >= 2);
    assert.ok(profile.lines.every((line) => line.length > 0));
    assert.ok(profile.pauseMs >= 18_000);
  }
});
