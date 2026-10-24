import type { PlayerIntent, VillageTopic } from './village-cognition.ts';

export type EqualLoafResidentId = 'mira' | 'tobin' | 'pip';
export type EqualLoafFactId =
  | 'equal-loaf-thomas-claim'
  | 'equal-loaf-household-count'
  | 'equal-loaf-garden-workers'
  | 'equal-loaf-inclusion';

export interface EqualLoafInput {
  eventId: string;
  residentId: EqualLoafResidentId;
  intent: PlayerIntent;
  topic: VillageTopic;
}

export interface EqualLoafResponse {
  eventId: string;
  speakerId: EqualLoafResidentId;
  lineId: string;
  text: string;
  revealedFactIds: readonly EqualLoafFactId[];
  closed: boolean;
  playerRealization?: { factId: 'equal-loaf-inclusion'; text: string };
}

export interface EqualLoafState {
  started: boolean;
  heardFactIds: readonly EqualLoafFactId[];
  revealedLineIds: readonly string[];
  closed: boolean;
  processedEvents: Readonly<Record<string, EqualLoafResponse>>;
}

export function createEqualLoafState(): EqualLoafState {
  return { started: false, heardFactIds: [], revealedLineIds: [], closed: false, processedEvents: {} };
}

/** Selects one bounded authored scene response; it never infers story facts from free text. */
export function respondToEqualLoaf(
  state: EqualLoafState,
  input: EqualLoafInput,
): { state: EqualLoafState; response: EqualLoafResponse } {
  const prior = state.processedEvents[input.eventId];
  if (prior) return { state, response: prior };

  if (state.closed) {
    return remember(state, input, makeResponse(input, 'equal-loaf.scene.closed', 'That is all for the loaf today. The village carries on around you.', [], true));
  }

  const beat = selectBeat(state, input);
  if (!beat) {
    return remember(state, input, makeResponse(input, 'equal-loaf.scene.no-response', 'They have nothing more to add just now.', [], false));
  }

  const alreadyHeardLine = state.revealedLineIds.includes(beat.lineId);
  const response = makeResponse(input, beat.lineId, beat.text, alreadyHeardLine ? [] : beat.factIds, beat.close, beat.playerRealization);
  const heardFactIds = Object.freeze([...new Set([...state.heardFactIds, ...response.revealedFactIds])].sort());
  const nextState: EqualLoafState = {
    ...state,
    started: state.started || beat.start,
    heardFactIds,
    revealedLineIds: unique([...state.revealedLineIds, beat.lineId]),
    closed: beat.close,
    processedEvents: { ...state.processedEvents, [input.eventId]: response },
  };
  return { state: nextState, response };
}

interface Beat {
  lineId: string;
  text: string;
  factIds: readonly EqualLoafFactId[];
  start: boolean;
  close: boolean;
  playerRealization?: EqualLoafResponse['playerRealization'];
}

function selectBeat(state: EqualLoafState, input: EqualLoafInput): Beat | undefined {
  if (input.residentId === 'pip' && input.intent === 'greet' && input.topic === 'general') {
    return {
      lineId: 'equal-loaf.thomas.welcome',
      text: 'Welcome. I set aside one loaf for every household. It is a small thing, but a shared table should start with everyone.',
      factIds: ['equal-loaf-thomas-claim'], start: true, close: false,
    };
  }

  if (input.residentId === 'tobin' && input.topic === 'route' && input.intent === 'ask_about_known_topic') {
    return {
      lineId: 'equal-loaf.james.household-map',
      text: 'I count one share for each household marked on the village map. That keeps the list even and easy to check.',
      factIds: ['equal-loaf-household-count'], start: false, close: false,
    };
  }

  if (input.residentId === 'mira' && input.topic === 'garden' && input.intent === 'ask_about_known_topic') {
    return {
      lineId: 'equal-loaf.anna.garden-workers',
      text: 'The gardeners tend those beds and bring vegetables to the table, but they are not on the household list. They asked me not to make them a public example. I only want their work counted as work.',
      factIds: ['equal-loaf-garden-workers'], start: false, close: false,
    };
  }

  if (input.residentId === 'pip' && input.topic === 'bakery' && input.intent === 'ask_for_help') {
    const hasBothAccounts = state.heardFactIds.includes('equal-loaf-household-count')
      && state.heardFactIds.includes('equal-loaf-garden-workers');
    return {
      lineId: 'equal-loaf.thomas.ordinary-close',
      text: 'I will set the loaf on the shared table. Stay a while if you like; there is room for another conversation.',
      factIds: [], start: false, close: true,
      ...(hasBothAccounts ? {
        playerRealization: {
          factId: 'equal-loaf-inclusion' as const,
          text: 'The count was even for the households on James’s map. The gardeners who helped feed the village were outside that count.',
        },
      } : {}),
    };
  }

  return undefined;
}

function makeResponse(
  input: EqualLoafInput,
  lineId: string,
  text: string,
  revealedFactIds: readonly EqualLoafFactId[],
  closed: boolean,
  playerRealization?: EqualLoafResponse['playerRealization'],
): EqualLoafResponse {
  return {
    eventId: input.eventId,
    speakerId: input.residentId,
    lineId,
    text,
    revealedFactIds: Object.freeze([...revealedFactIds]),
    closed,
    ...(playerRealization ? { playerRealization } : {}),
  };
}

function remember(
  state: EqualLoafState,
  input: EqualLoafInput,
  response: EqualLoafResponse,
): { state: EqualLoafState; response: EqualLoafResponse } {
  return {
    state: { ...state, processedEvents: { ...state.processedEvents, [input.eventId]: response } },
    response,
  };
}

function unique<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)]);
}
