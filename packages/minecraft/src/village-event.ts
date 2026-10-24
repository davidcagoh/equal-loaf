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

export interface VillageNativePttBeginCommand {
  version: 1;
  type: 'ptt.native.begin';
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

export interface VillagePttBindResidentSessionCommand {
  version: 1;
  type: 'ptt.session.bind';
  turnId: string;
  residentSessionId: string;
  at: number;
}

export interface VillageResidentSpeechStartCommand {
  version: 1;
  type: 'ptt.speech.start';
  turnId: string;
  residentSessionId: string;
  responseId: string;
  itemId: string;
  at: number;
}

export interface VillageResidentSpeechFinishCommand {
  version: 1;
  type: 'ptt.speech.finish';
  turnId: string;
  residentSessionId: string;
  responseId: string;
  itemId: string;
  playback: 'completed' | 'interrupted';
  transcript?: string;
  at: number;
}

export interface VillagePlayerSpeechFinishCommand {
  version: 1;
  type: 'ptt.player.speech.finish';
  turnId: string;
  residentSessionId: string;
  itemId: string;
  transcript: string;
  at: number;
}

export interface VillageNativePttEndCommand {
  version: 1;
  type: 'ptt.native.end';
  turnId: string;
  residentSessionId: string;
  at: number;
}

export type VillagePttCommand = VillagePttBeginCommand | VillageNativePttBeginCommand | VillagePttCompleteCommand | VillagePttCancelCommand
  | VillagePttBindResidentSessionCommand | VillageResidentSpeechStartCommand
  | VillageResidentSpeechFinishCommand | VillagePlayerSpeechFinishCommand | VillageNativePttEndCommand;

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
  recentHeardSpeech?: readonly { eventId: string; speakerId: string; speakerName: string; text: string; tick: number }[];
}

export type VillagePttAck =
  | { version: 1; type: 'ptt.ack'; phase: 'begin'; turnId: string; status: 'ready'; resident: VillagePttBeginContext }
  | { version: 1; type: 'ptt.ack'; phase: 'begin'; turnId: string; status: 'no_resident'; guidance?: string }
  | { version: 1; type: 'ptt.ack'; phase: 'begin'; turnId: string; status: 'expired' | 'duplicate' | 'unavailable' }
  | { version: 1; type: 'ptt.ack'; phase: 'cancel'; turnId: string; status: 'cancelled' | 'expired' | 'duplicate' | 'no_session' | 'unavailable' }
  | { version: 1; type: 'ptt.ack'; phase: 'complete'; turnId: string; status: 'accepted' | 'fallback'; residentId: string; speakerName: string; lineId: string; eventId: string }
  | { version: 1; type: 'ptt.ack'; phase: 'complete'; turnId: string; status: 'rejected' | 'expired' | 'duplicate' | 'no_session' | 'unavailable' };

const TURN_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_NATIVE_TRANSCRIPT_BYTES = 1_000;
export const MAX_PTT_COMMAND_BYTES = 8_192;

export function isVillagePttCommand(value: unknown): value is VillagePttCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  if (command.version !== 1 || !TURN_ID_PATTERN.test(String(command.turnId ?? ''))
    || typeof command.at !== 'number' || !Number.isSafeInteger(command.at)
    || Math.abs(Date.now() - command.at) > 30_000) return false;

  if (command.type === 'ptt.begin' || command.type === 'ptt.native.begin' || command.type === 'ptt.cancel') {
    return Object.keys(command).sort().join(',') === 'at,turnId,type,version';
  }
  if (command.type === 'ptt.complete') {
    return Object.keys(command).sort().join(',') === 'at,response,turnId,type,version'
      && (command.response === null || asSemanticResponse(command.response) !== null);
  }
  if (command.type === 'ptt.session.bind' || command.type === 'ptt.native.end') {
    return Object.keys(command).sort().join(',') === 'at,residentSessionId,turnId,type,version'
      && TURN_ID_PATTERN.test(String(command.turnId ?? ''))
      && SESSION_ID_PATTERN.test(String(command.residentSessionId ?? ''));
  }
  if (command.type === 'ptt.speech.start') {
    return Object.keys(command).sort().join(',') === 'at,itemId,residentSessionId,responseId,turnId,type,version'
      && TURN_ID_PATTERN.test(String(command.turnId ?? ''))
      && SESSION_ID_PATTERN.test(String(command.residentSessionId ?? ''))
      && PROVIDER_ID_PATTERN.test(String(command.responseId ?? ''))
      && PROVIDER_ID_PATTERN.test(String(command.itemId ?? ''));
  }
  if (command.type === 'ptt.speech.finish') {
    const hasTranscript = Object.hasOwn(command, 'transcript');
    if (Object.keys(command).sort().join(',') !== (hasTranscript
      ? 'at,itemId,playback,residentSessionId,responseId,transcript,turnId,type,version'
      : 'at,itemId,playback,residentSessionId,responseId,turnId,type,version')) return false;
    if (!TURN_ID_PATTERN.test(String(command.turnId ?? ''))
      || !SESSION_ID_PATTERN.test(String(command.residentSessionId ?? ''))
      || !PROVIDER_ID_PATTERN.test(String(command.responseId ?? ''))
      || !PROVIDER_ID_PATTERN.test(String(command.itemId ?? ''))
      || (command.playback !== 'completed' && command.playback !== 'interrupted')) return false;
    if (!hasTranscript) return command.playback === 'interrupted';
    return command.playback === 'completed' && typeof command.transcript === 'string'
      && command.transcript.trim().length > 0
      && Buffer.byteLength(command.transcript, 'utf8') <= MAX_NATIVE_TRANSCRIPT_BYTES
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command.transcript);
  }
  if (command.type === 'ptt.player.speech.finish') {
    return Object.keys(command).sort().join(',') === 'at,itemId,residentSessionId,transcript,turnId,type,version'
      && SESSION_ID_PATTERN.test(String(command.residentSessionId ?? ''))
      && PROVIDER_ID_PATTERN.test(String(command.itemId ?? ''))
      && typeof command.transcript === 'string' && command.transcript.trim().length > 0
      && Buffer.byteLength(command.transcript, 'utf8') <= MAX_NATIVE_TRANSCRIPT_BYTES
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command.transcript);
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

export interface VillageResidentPositionsEvent {
  type: 'village.residents';
  timestamp: number;
  residents: readonly { residentId: string; name: string; position: { x: number; y: number; z: number } }[];
}

export function isVillageResidentPositionsEvent(value: unknown): value is VillageResidentPositionsEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (Object.keys(event).sort().join(',') !== 'residents,timestamp,type'
    || event.type !== 'village.residents' || !Number.isSafeInteger(event.timestamp)
    || !Array.isArray(event.residents) || event.residents.length > 32) return false;
  const residentIds = new Set<string>();
  return event.residents.every((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const resident = raw as Record<string, unknown>;
    if (Object.keys(resident).sort().join(',') !== 'name,position,residentId'
      || typeof resident.residentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(resident.residentId)
      || residentIds.has(resident.residentId)
      || typeof resident.name !== 'string' || resident.name.length < 1 || resident.name.length > 80
      || !resident.position || typeof resident.position !== 'object' || Array.isArray(resident.position)) return false;
    const position = resident.position as Record<string, unknown>;
    if (Object.keys(position).sort().join(',') !== 'x,y,z'
      || ![position.x, position.y, position.z].every((coordinate) => typeof coordinate === 'number'
        && Number.isFinite(coordinate) && Math.abs(coordinate) <= 1_000_000)) return false;
    residentIds.add(resident.residentId);
    return true;
  });
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
