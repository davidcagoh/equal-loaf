import { createHash } from 'node:crypto';
import { distance3D, RESIDENT_HEARING_RADIUS, type Position3D } from './village-encounters.ts';

const MAX_TRANSCRIPT_BYTES = 1_000;
const MAX_CONSUMED_ITEM_IDS = 512;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export interface NativePlayerSpeechPositionSample {
  tick: number;
  speakerPosition: Position3D;
  residents: readonly { residentId: string; position: Position3D }[];
}

export interface TransientPlayerSpeechPerception {
  type: 'player.speech.perceived';
  eventId: string;
  speakerId: 'player';
  text: string;
  recipientIds: readonly string[];
  startedAtTick: number;
  completedAtTick: number;
}

/**
 * Project provider-final input transcription only to residents continuously
 * within engine-authoritative range across the held native turn. The provider
 * item ID is correlated to the active server-owned turn/session; player identity
 * and all positions are fixed here rather than accepted from the caller.
 */
export function projectCompletedPlayerSpeech(input: {
  session: { turnId: string; sessionId: string; itemId: string };
  report: { turnId: string; sessionId: string; itemId: string; transcript: string };
  samples: readonly NativePlayerSpeechPositionSample[];
  consumedItemIds: Set<string>;
}): TransientPlayerSpeechPerception | null {
  const { session, report } = input;
  if (!SAFE_ID.test(session.turnId) || !SAFE_ID.test(session.sessionId) || !SAFE_ID.test(session.itemId)
    || report.turnId !== session.turnId || report.sessionId !== session.sessionId || report.itemId !== session.itemId
    || typeof report.transcript !== 'string' || !report.transcript.trim()
    || new TextEncoder().encode(report.transcript).byteLength > MAX_TRANSCRIPT_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(report.transcript)
    || input.consumedItemIds.has(session.itemId) || input.samples.length < 2) return null;

  const samples = [...input.samples].sort((left, right) => left.tick - right.tick);
  if (!samples.every((sample, index) => Number.isSafeInteger(sample.tick) && sample.tick >= 0
    && validPosition(sample.speakerPosition) && Array.isArray(sample.residents)
    && (index === 0 || sample.tick > samples[index - 1]!.tick)
    && sample.residents.every(({ residentId, position }) => SAFE_ID.test(residentId) && validPosition(position)))) return null;

  if (input.consumedItemIds.size >= MAX_CONSUMED_ITEM_IDS) {
    const oldest = input.consumedItemIds.values().next().value as string | undefined;
    if (oldest !== undefined) input.consumedItemIds.delete(oldest);
  }
  input.consumedItemIds.add(session.itemId);

  const recipientIds = new Set(samples[0]!.residents
    .filter(({ position }) => distance3D(samples[0]!.speakerPosition, position) <= RESIDENT_HEARING_RADIUS)
    .map(({ residentId }) => residentId));
  for (const sample of samples.slice(1)) {
    const inRange = new Set(sample.residents
      .filter(({ position }) => distance3D(sample.speakerPosition, position) <= RESIDENT_HEARING_RADIUS)
      .map(({ residentId }) => residentId));
    for (const recipientId of recipientIds) if (!inRange.has(recipientId)) recipientIds.delete(recipientId);
  }
  if (recipientIds.size === 0) return null;

  return {
    type: 'player.speech.perceived',
    eventId: `player-speech:${createHash('sha256').update(`${session.sessionId}:${session.turnId}:${session.itemId}`).digest('base64url').slice(0, 32)}`,
    speakerId: 'player',
    text: report.transcript,
    recipientIds: [...recipientIds],
    startedAtTick: samples[0]!.tick,
    completedAtTick: samples.at(-1)!.tick,
  };
}

function validPosition(position: Position3D): boolean {
  return Boolean(position && [position.x, position.y, position.z].every((coordinate) => Number.isFinite(coordinate)
    && Math.abs(coordinate) <= 1_000_000));
}
