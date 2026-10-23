import assert from 'node:assert/strict';
import test from 'node:test';
import { formatActionOutcome, formatPendingOutcome } from './action-outcome.ts';

test('formats only confirmed action success and includes the executor detail', () => {
  assert.deepEqual(formatActionOutcome('follow', {
    type: 'action.completed',
    eventId: 'event-1',
    timestamp: 10,
    goalId: 'goal-1',
    detail: 'Reached the player',
    latencyMs: 420,
  }), {
    status: 'completed',
    message: 'Nice, I followed you. Reached the player. Where to next?',
    detail: 'Reached the player',
    latencyMs: 420,
  });
});

test('reports cancellation as cancellation and acknowledges the change', () => {
  const result = formatActionOutcome('gather', {
    type: 'action.cancelled',
    eventId: 'event-2',
    timestamp: 20,
    goalId: 'goal-2',
    reason: 'Stopped by user',
    latencyMs: 80,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.message, 'Got it, I stopped gathering.');
  assert.equal(result.reason, 'Stopped by user');
  assert.equal(result.message.toLowerCase().includes('completed'), false);
});

test('reports failure truthfully and includes a relevant recovery suggestion', () => {
  const result = formatActionOutcome('retreat', {
    type: 'action.failed',
    eventId: 'event-3',
    timestamp: 30,
    goalId: 'goal-3',
    reason: 'Minecraft adapter is not connected',
    latencyMs: 5,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.message, 'I could not return to safety: Minecraft adapter is not connected. Connect the game first, then I can try again.');
});

test('never describes an accepted but nonterminal goal as complete', () => {
  assert.deepEqual(formatPendingOutcome('defend', true), {
    status: 'running',
    message: 'I started defending you, but the action has not completed yet.',
  });
});

test('describes accepted queued goals without claiming they started', () => {
  assert.deepEqual(formatPendingOutcome('follow', false), {
    status: 'queued',
    message: 'I have your request to follow you, but it is still queued.',
  });
  assert.equal(formatActionOutcome('stop', {
    type: 'action.completed', eventId: 'event-stop', timestamp: 1, goalId: 'stop-1',
  }).message, 'The stop request completed.');
});
