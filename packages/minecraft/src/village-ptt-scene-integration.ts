import {
  reduceVillageObservation,
  resolvePttResidentIntent,
  type SemanticResponse,
  type ResidentIntentContext,
  type SelectedResidentIntent,
  type VillageCognitionState,
  type VillageTopic,
} from './village-cognition.ts';
import { createVillageDialogueEvent, type VillageDialogueEvent } from './village-event.ts';
import { createEqualLoafState, respondToEqualLoaf, type EqualLoafResidentId, type EqualLoafState } from './village-short-scene.ts';
import { distance3D, PLAYER_RESPONSE_RADIUS } from './village-encounters.ts';

export interface EqualLoafPttTurnInput {
  state: VillageCognitionState;
  sceneState: EqualLoafState;
  turnId: string;
  residentId: EqualLoafResidentId;
  residentName: string;
  locationId: string;
  tick: number;
  semanticResponse: SemanticResponse;
  position: { x: number; y: number; z: number };
  heardResidentIds: readonly string[];
}

export interface EqualLoafPttTurnResult {
  state: VillageCognitionState;
  sceneState: EqualLoafState;
  intent: SelectedResidentIntent;
  context: ResidentIntentContext;
  dialogueEvent: VillageDialogueEvent;
  playerRealization?: { factId: 'equal-loaf-inclusion'; text: string };
}

export interface EqualLoafPttCompletionInput extends EqualLoafPttTurnInput {
  explorerPosition: { x: number; y: number; z: number };
  applyAction: (intent: SelectedResidentIntent, explorerPosition: { x: number; y: number; z: number }) => void;
  emitDialogue: (event: VillageDialogueEvent) => string | null;
}

export type EqualLoafPttCompletionResult =
  | { status: 'accepted'; state: VillageCognitionState; sceneState: EqualLoafState; intent: SelectedResidentIntent; lineId: string; eventId: string }
  | { status: 'expired' | 'rejected'; state: VillageCognitionState; sceneState: EqualLoafState };

/** Resolve one validated semantic choice through resident-local cognition and the isolated authored scene. */
export function resolveEqualLoafPttTurn(input: EqualLoafPttTurnInput): EqualLoafPttTurnResult | null {
  const intentResolution = resolvePttResidentIntent(input.state, {
    residentId: input.residentId,
    locationId: input.locationId,
    tick: input.tick,
  }, input.tick >>> 0, input.semanticResponse);
  if (!intentResolution || !intentResolution.intent.speech.lineId.startsWith('equal-loaf.')) return null;

  const sceneResult = respondToEqualLoaf(input.sceneState, {
    eventId: input.turnId,
    residentId: input.residentId,
    intent: intentResolution.context.playerIntent,
    topic: intentResolution.context.topic,
  });
  if (sceneResult.response.lineId !== intentResolution.intent.speech.lineId
    && sceneResult.response.lineId !== 'equal-loaf.scene.closed') return null;

  let state = input.state;
  for (const [index, factId] of sceneResult.response.revealedFactIds.entries()) {
    state = reduceVillageObservation(state, {
      type: 'resident.fact_disclosed',
      eventId: `equal-loaf-disclosure-${input.turnId}-${index}`,
      tick: input.tick,
      recipientIds: [input.residentId],
      speakerId: input.residentId,
      factId,
    });
  }

  const claimedFactId = sceneResult.response.revealedFactIds[0];
  const listenerIds = [...new Set(input.heardResidentIds)].filter((residentId) => residentId !== input.residentId);
  if (listenerIds.length > 0) {
    const observation: {
      type: 'resident.utterance';
      eventId: string;
      tick: number;
      recipientIds: readonly string[];
      speakerId: string;
      topic: VillageTopic;
      claimedFactId?: string;
    } = {
      type: 'resident.utterance',
      eventId: `equal-loaf-heard-${input.turnId}`,
      tick: input.tick,
      recipientIds: listenerIds,
      speakerId: input.residentId,
      topic: intentResolution.context.topic,
      ...(claimedFactId ? { claimedFactId } : {}),
    };
    state = reduceVillageObservation(state, observation);
  }

  const response = sceneResult.response;
  const dialogueEvent = createVillageDialogueEvent({
    eventId: `ptt-${input.turnId}`,
    lineId: response.lineId,
    source: 'ptt-response',
    turnId: input.turnId,
    speakerId: input.residentId,
    speakerName: input.residentName,
    line: response.text,
    position: input.position,
    timestamp: input.tick,
  });
  return {
    state,
    sceneState: sceneResult.state,
    intent: intentResolution.intent,
    context: intentResolution.context,
    dialogueEvent,
    ...(response.playerRealization ? { playerRealization: response.playerRealization } : {}),
  };
}

/** Complete one scene turn only while the live speaker is in PTT range; production and IPC fixtures share this handler. */
export function completeEqualLoafPttTurn(input: EqualLoafPttCompletionInput): EqualLoafPttCompletionResult {
  if (distance3D(input.explorerPosition, input.position) > PLAYER_RESPONSE_RADIUS) {
    return { status: 'expired', state: input.state, sceneState: input.sceneState };
  }
  const result = resolveEqualLoafPttTurn(input);
  if (!result) return { status: 'rejected', state: input.state, sceneState: input.sceneState };

  input.applyAction(result.intent, input.explorerPosition);
  const eventId = input.emitDialogue(result.dialogueEvent);
  if (!eventId) return { status: 'rejected', state: input.state, sceneState: input.sceneState };

  const state = reduceVillageObservation(result.state, {
    type: 'beat.completed',
    eventId: `${input.turnId}:beat`,
    tick: input.tick,
    residentId: result.intent.residentId,
    beatId: result.intent.beatId,
  });
  return {
    status: 'accepted',
    state,
    sceneState: result.sceneState,
    intent: result.intent,
    lineId: result.dialogueEvent.lineId ?? result.intent.speech.lineId,
    eventId,
  };
}
