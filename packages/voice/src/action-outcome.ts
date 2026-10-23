import type { CompanionEvent, GoalKind } from '../../contracts/src/index.ts';

type TerminalActionEvent = Extract<CompanionEvent, {
  type: 'action.completed' | 'action.cancelled' | 'action.failed';
}>;

const actionDescriptions: Record<GoalKind, string> = {
  follow: 'follow you',
  stop: 'stop',
  approach: 'move closer',
  gather: 'gather resources',
  give: 'hand over the item',
  defend: 'defend you',
  retreat: 'return to safety',
  report: 'check the game state',
};

const completedMessages: Record<GoalKind, string> = {
  follow: 'Nice, I followed you.',
  stop: 'The stop request completed.',
  approach: 'I moved closer.',
  gather: 'Nice, I finished gathering.',
  give: 'There you go.',
  defend: 'I defended you.',
  retreat: 'I made it back to safety.',
  report: 'I checked the game state.',
};

const cancelledMessages: Partial<Record<GoalKind, string>> = {
  follow: 'Got it, I stopped following.',
  gather: 'Got it, I stopped gathering.',
  defend: 'Got it, I stopped defending.',
  retreat: 'Got it, I stopped retreating.',
};

/** Turn an executor terminal event into a truthful, concise tool result for Realtime. */
export function formatActionOutcome(kind: GoalKind, event: TerminalActionEvent): Record<string, string | number> {
  if (event.type === 'action.completed') {
    const opening = completedMessages[kind];
    const detail = event.detail ? ` ${event.detail.replace(/[.!?]+$/, '')}.` : '';
    const suggestion = kind === 'follow' ? ' Where to next?' : '';
    return {
      status: 'completed',
      message: `${opening}${detail}${suggestion}`,
      ...(event.detail ? { detail: event.detail } : {}),
      ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
    };
  }

  if (event.type === 'action.cancelled') {
    const message = cancelledMessages[kind] ?? 'Got it, I stopped that action.';
    return {
      status: 'cancelled',
      message,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
    };
  }

  const reason = event.reason;
  const recovery = /adapter is not connected/i.test(reason)
    ? 'Connect the game first, then I can try again.'
    : 'Want me to try again or do something else?';
  return {
    status: 'failed',
    message: `I could not ${actionDescriptions[kind]}${reason ? `: ${reason}` : '.'}${reason && !/[.!?]$/.test(reason) ? '.' : ''} ${recovery}`,
    reason,
    ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
  };
}

/** Avoid claiming work began while the scheduler has only acknowledged or queued submission. */
export function formatPendingOutcome(kind: GoalKind, started: boolean): { status: 'queued' | 'running'; message: string } {
  const action: Record<GoalKind, string> = {
    follow: 'following you',
    stop: 'stopping',
    approach: 'moving closer',
    gather: 'gathering resources',
    give: 'handing over the item',
    defend: 'defending you',
    retreat: 'returning to safety',
    report: 'checking the game state',
  };
  const phrase = action[kind];
  if (!started) {
    const queuedPhrase = kind === 'stop' ? 'stop the current action' : phrase.replace(/ing you$/, ' you');
    return { status: 'queued', message: `I have your request to ${queuedPhrase}, but it is still queued.` };
  }
  return {
    status: 'running',
    message: `I started ${phrase}, but the action has not completed yet.`,
  };
}
