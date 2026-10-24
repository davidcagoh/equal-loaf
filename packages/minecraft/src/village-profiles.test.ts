import assert from 'node:assert/strict';
import test from 'node:test';
import { villageDialogue, villageMysteryDialogue, villageProfiles } from './village-profiles.ts';

test('village residents have distinct identities and multi-stop role routines', () => {
  assert.equal(villageProfiles.length, 3);
  assert.equal(new Set(villageProfiles.map(({ id }) => id)).size, 3);
  assert.equal(new Set(villageProfiles.map(({ username }) => username)).size, 3);
  assert.equal(new Set(villageProfiles.map(({ role }) => role)).size, 3);
  for (const profile of villageProfiles) {
    assert.match(profile.username, /^[A-Za-z0-9_]{3,16}$/);
    assert.ok(profile.goal.length > 0);
    assert.ok(profile.knownFactIds.length > 0);
    assert.ok(profile.routine.length >= 3);
    assert.equal(new Set(profile.routine.map(({ id }) => id)).size, profile.routine.length);
    assert.ok(profile.pauseMs >= 10_000);
  }
});

test('mystery clues are immutable authored beats with a distinct fixed progression', () => {
  assert.deepEqual(villageMysteryDialogue.map(({ clueId }) => clueId), [
    'silent-bell', 'flour-ledger', 'route-mark', 'pip-denial', 'mira-sighting', 'pip-contradiction',
  ]);
  assert.equal(new Set(villageMysteryDialogue.map(({ clueId }) => clueId)).size, villageMysteryDialogue.length);
  assert.ok(villageMysteryDialogue.every(({ line }) => line.length > 0 && !/\bkill|murder|dead|blood\b/i.test(line)));
});

test('authored dialogue has multiple ordered two-way exchanges with shared references', () => {
  assert.ok(villageDialogue.length >= 6);
  for (const turn of villageDialogue) {
    assert.ok(villageProfiles.some(({ id }) => id === turn.speakerId));
    assert.ok(villageProfiles.some(({ id }) => id === turn.listenerId));
    assert.notEqual(turn.speakerId, turn.listenerId);
    assert.ok(villageProfiles.find(({ id }) => id === turn.speakerId)?.routine.some(({ id }) => id === turn.stopId));
    assert.ok(turn.line.length > 0);
  }
  for (const profile of villageProfiles) {
    for (const stop of profile.routine) {
      assert.ok(villageDialogue.some(({ speakerId, stopId }) => speakerId === profile.id && stopId === stop.id));
    }
  }

  const directedPairs = new Set(villageDialogue.map(({ speakerId, listenerId }) => `${speakerId}->${listenerId}`));
  assert.ok(directedPairs.has('mira->pip') && directedPairs.has('pip->mira'));
  assert.ok(directedPairs.has('tobin->mira') && directedPairs.has('mira->tobin'));
  assert.match(villageDialogue[1]?.line ?? '', /loaf|seed/i);
  assert.match(villageDialogue[3]?.line ?? '', /water|seedling/i);
  assert.match(villageDialogue[5]?.line ?? '', /map|bakery/i);
});
