import type {
  PlayerIntent,
  SemanticResponse,
  VillageTopic,
} from './village-cognition.ts';

export interface VillagePttBeginCommand {
  version: 1;
  type: 'ptt.begin';
  turnId: string;
  at: number;
}

export interface VillagePttCompleteCommand {
  version: 1;
  type: 'ptt.complete';
  turnId: string;
  response: unknown;
  at: number;
}

export interface VillagePttCancelCommand {
  version: 1;
  type: 'ptt.cancel';
  turnId: string;
  at: number;
}

export type VillagePttCommand = VillagePttBeginCommand | VillagePttCompleteCommand | VillagePttCancelCommand;

export interface VillagePttBeginContext {
  id: string;
  name: string;
  role: string;
  goal: string;
  locationId: string;
  topics: readonly VillageTopic[];
  facts: readonly string[];
  responseOptions: readonly {
    lineId: string;
    summary: string;
    allowedIntents: readonly PlayerIntent[];
    topics: readonly VillageTopic[];
  }[];
  relationship: 'unfamiliar' | 'cautious' | 'trusted';
}

export type VillagePttAck =
  | { version: 1; type: 'ptt.ack'; phase: 'begin'; turnId: string; status: 'ready'; resident: VillagePttBeginContext }
  | { version: 1; type: 'ptt.ack'; phase: 'begin'; turnId: string; status: 'no_resident' | 'expired' | 'duplicate' | 'unavailable' }
  | { version: 1; type: 'ptt.ack'; phase: 'cancel'; turnId: string; status: 'cancelled' | 'expired' | 'duplicate' | 'no_session' | 'unavailable' }
  | { version: 1; type: 'ptt.ack'; phase: 'complete'; turnId: string; status: 'accepted' | 'fallback'; residentId: string; speakerName: string; lineId: string; eventId: string }
  | { version: 1; type: 'ptt.ack'; phase: 'complete'; turnId: string; status: 'rejected' | 'expired' | 'duplicate' | 'no_session' | 'unavailable' };

const TURN_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const MAX_PTT_COMMAND_BYTES = 4_096;

export function isVillagePttCommand(value: unknown): value is VillagePttCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  if (command.version !== 1 || !TURN_ID_PATTERN.test(String(command.turnId ?? ''))
    || typeof command.at !== 'number' || !Number.isSafeInteger(command.at)
    || Math.abs(Date.now() - command.at) > 30_000) return false;

  if (command.type === 'ptt.begin' || command.type === 'ptt.cancel') {
    return Object.keys(command).sort().join(',') === 'at,turnId,type,version';
  }
  if (command.type === 'ptt.complete') {
    return Object.keys(command).sort().join(',') === 'at,response,turnId,type,version'
      && (command.response === null || asSemanticResponse(command.response) !== null);
  }
  return false;
}

export function asSemanticResponse(value: unknown): SemanticResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (Object.keys(response).sort().join(',') !== 'lineId,playerIntent,topic'
    || typeof response.playerIntent !== 'string' || typeof response.topic !== 'string' || typeof response.lineId !== 'string') return null;
  return response as unknown as SemanticResponse;
}

export interface VillageDialogueEvent {
  version?: 1;
  type: 'village.dialogue';
  eventId?: string;
  lineId?: string;
  source?: 'ambient' | 'ptt-response';
  turnId?: string;
  speakerId: string;
  speakerName: string;
  line: string;
  position: { x: number; y: number; z: number };
  listenerId?: string;
  listenerName?: string;
  timestamp: number;
}

export function createVillageDialogueEvent(input: {
  eventId?: string;
  lineId?: string;
  source?: 'ambient' | 'ptt-response';
  turnId?: string;
  speakerId: string;
  speakerName: string;
  line: string;
  position: { x: number; y: number; z: number };
  listenerId?: string;
  listenerName?: string;
  timestamp?: number;
}): VillageDialogueEvent {
  return {
    version: 1,
    type: 'village.dialogue',
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.lineId ? { lineId: input.lineId } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    speakerId: input.speakerId,
    speakerName: input.speakerName,
    line: input.line,
    position: { ...input.position },
    ...(input.listenerId ? { listenerId: input.listenerId } : {}),
    ...(input.listenerName ? { listenerName: input.listenerName } : {}),
    timestamp: input.timestamp ?? Date.now(),
  };
}
