import assert from 'node:assert/strict';
import test from 'node:test';
import { createEqualLoafState, respondToEqualLoaf } from './village-short-scene.ts';
import type { EqualLoafInput } from './village-short-scene.ts';

function ask(residentId: EqualLoafInput['residentId'], topic: EqualLoafInput['topic'], eventId: string, intent: EqualLoafInput['intent'] = 'ask_about_known_topic'): EqualLoafInput {
  return { eventId, residentId, intent, topic };
}

function run(inputs: readonly EqualLoafInput[]) {
  return inputs.reduce((state, input) => respondToEqualLoaf(state, input).state, createEqualLoafState());
}

test('Thomas welcomes the newcomer and names the public household-count claim', () => {
  const result = respondToEqualLoaf(createEqualLoafState(), ask('pip', 'general', 'welcome', 'greet'));
  assert.match(result.response.text, /one loaf for every household/i);
  assert.deepEqual(result.response.revealedFactIds, ['equal-loaf-thomas-claim']);
  assert.equal(result.response.eventId, 'welcome');
});

test('James and Anna accounts can be heard in either order before the player recognizes the mismatch', () => {
  const accounts = [ask('tobin', 'route', 'map'), ask('mira', 'garden', 'garden')];
  const ending = (order: EqualLoafInput[]) => {
    const state = run([ask('pip', 'general', 'welcome', 'greet'), ...order]);
    return respondToEqualLoaf(state, ask('pip', 'bakery', 'close', 'ask_for_help'));
  };
  const first = ending(accounts);
  const second = ending([...accounts].reverse());
  assert.equal(first.response.lineId, 'equal-loaf.thomas.ordinary-close');
  assert.deepEqual(first.response, second.response);
  assert.doesNotMatch(first.response.text, /garden workers|household list/i);
  assert.equal(first.response.closed, true);
  assert.deepEqual(first.response.revealedFactIds, []);
  assert.equal(first.response.playerRealization?.factId, 'equal-loaf-inclusion');
  assert.match(first.response.playerRealization?.text ?? '', /gardeners.*outside that count/i);
});

test('generic bakery help after both accounts does not tell Thomas Anna’s private information', () => {
  const state = run([ask('tobin', 'route', 'map'), ask('mira', 'garden', 'garden')]);
  const result = respondToEqualLoaf(state, ask('pip', 'bakery', 'close', 'ask_for_help'));
  assert.equal(result.response.lineId, 'equal-loaf.thomas.ordinary-close');
  assert.doesNotMatch(result.response.text, /garden workers|gardeners|not on the list/i);
  assert.deepEqual(result.response.revealedFactIds, []);
  assert.equal(result.response.playerRealization?.factId, 'equal-loaf-inclusion');
});

test('Thomas close from his own welcome contains no knowledge of the garden account', () => {
  const state = run([ask('pip', 'general', 'welcome', 'greet')]);
  const result = respondToEqualLoaf(state, ask('pip', 'bakery', 'close', 'ask_for_help'));
  assert.equal(result.response.lineId, 'equal-loaf.thomas.ordinary-close');
  assert.doesNotMatch(result.response.text, /garden workers|not on the list/i);
  assert.equal(result.response.playerRealization, undefined);
});

test('an incomplete exploration closes ordinarily without exposing Anna’s account', () => {
  const state = run([ask('pip', 'general', 'welcome', 'greet'), ask('tobin', 'route', 'map')]);
  const result = respondToEqualLoaf(state, ask('pip', 'bakery', 'close', 'ask_for_help'));
  assert.equal(result.response.lineId, 'equal-loaf.thomas.ordinary-close');
  assert.doesNotMatch(result.response.text, /garden workers|not on the list/i);
  assert.deepEqual(result.response.revealedFactIds, []);
  assert.equal(result.response.closed, true);
});

test('each resident only reveals their own account and repeated questions do not advance the scene', () => {
  let state = createEqualLoafState();
  const first = respondToEqualLoaf(state, ask('tobin', 'route', 'map'));
  state = first.state;
  assert.match(first.response.text, /household/i);
  assert.deepEqual(first.response.revealedFactIds, ['equal-loaf-household-count']);
  const repeated = respondToEqualLoaf(state, ask('tobin', 'route', 'map-again'));
  assert.equal(repeated.response.lineId, first.response.lineId);
  assert.deepEqual(repeated.response.revealedFactIds, []);
  const privateAccount = respondToEqualLoaf(repeated.state, ask('mira', 'garden', 'garden'));
  assert.match(privateAccount.response.text, /asked me not to make them a public example/i);
  assert.deepEqual(privateAccount.response.revealedFactIds, ['equal-loaf-garden-workers']);
  assert.deepEqual(privateAccount.state.heardFactIds, ['equal-loaf-garden-workers', 'equal-loaf-household-count']);
});

test('duplicate event IDs are idempotent and the closed scene has a finite final response', () => {
  let state = run([ask('pip', 'general', 'welcome', 'greet'), ask('tobin', 'route', 'map'), ask('mira', 'garden', 'garden')]);
  const closingInput = ask('pip', 'bakery', 'close', 'ask_for_help');
  const closed = respondToEqualLoaf(state, closingInput);
  state = closed.state;
  assert.deepEqual(respondToEqualLoaf(state, closingInput), closed);
  const later = respondToEqualLoaf(state, ask('mira', 'garden', 'after-close'));
  assert.equal(later.response.closed, true);
  assert.equal(later.response.lineId, 'equal-loaf.scene.closed');
  assert.deepEqual(later.response.revealedFactIds, []);
});
