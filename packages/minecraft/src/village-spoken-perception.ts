import { createHash } from 'node:crypto';
import { distance3D, RESIDENT_HEARING_RADIUS, type Position3D } from './village-encounters.ts';

const MAX_TRANSCRIPT_BYTES = 1_000;
const MAX_CONSUMED_RESPONSE_IDS = 512;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export interface NativeSpeechPositionSample {
  /** Monotonic engine tick sampled while this response is being played. */
  tick: number;
  speakerPosition: Position3D;
  residents: readonly { residentId: string; position: Position3D }[];
}

export interface TransientResidentSpeechPerception {
  type: 'resident.speech.perceived';
  eventId: string;
  speakerId: string;
  responseId: string;
  /** Ephemeral attributed speech. Never copy this field into durable cognition or logs. */
  text: string;
  recipientIds: readonly string[];
  startedAtTick: number;
  completedAtTick: number;
}

/**
 * Project a completed native speech response to residents who stayed in range
 * throughout browser-reported playback. `speakerId` and positions must come
 * from the engine's active session/world state, never from the provider event.
 * A browser completion callback is not proof of physical audibility.
 */
export function projectCompletedResidentSpeech(input: {
  /** Resolved from server-owned active-session state, not from a browser event. */
  session: { turnId: string; sessionId: string; speakerId: string; responseId: string; itemId: string };
  playbackReport: {
    turnId: string;
    sessionId: string;
    responseId: string;
    itemId: string;
    playback: 'completed' | 'interrupted';
    transcript?: string;
  };
  samples: readonly NativeSpeechPositionSample[];
  consumedResponseIds: Set<string>;
}): TransientResidentSpeechPerception | null {
  const { session, playbackReport } = input;
  if (playbackReport.turnId !== session.turnId || playbackReport.sessionId !== session.sessionId
    || playbackReport.responseId !== session.responseId || playbackReport.itemId !== session.itemId) return null;
  const responseKey = `${session.sessionId}:${session.turnId}:${session.responseId}:${session.itemId}`;
  if (!SAFE_PROVIDER_ID.test(session.turnId) || !SAFE_PROVIDER_ID.test(session.sessionId)
    || !SAFE_PROVIDER_ID.test(session.responseId) || !SAFE_PROVIDER_ID.test(session.itemId)
    || !SAFE_PROVIDER_ID.test(session.speakerId) || input.consumedResponseIds.has(responseKey)) return null;
  if (input.consumedResponseIds.size >= MAX_CONSUMED_RESPONSE_IDS) {
    const oldest = input.consumedResponseIds.values().next().value as string | undefined;
    if (oldest !== undefined) input.consumedResponseIds.delete(oldest);
  }
  input.consumedResponseIds.add(responseKey);

  if (playbackReport.playback !== 'completed') return null;
  if (typeof playbackReport.transcript !== 'string' || !playbackReport.transcript.trim()
    || new TextEncoder().encode(playbackReport.transcript).byteLength > MAX_TRANSCRIPT_BYTES || input.samples.length < 2) return null;

  const samples = [...input.samples].sort((left, right) => left.tick - right.tick);
  if (!samples.every((sample, index) => Number.isSafeInteger(sample.tick) && sample.tick >= 0
    && validPosition(sample.speakerPosition) && Array.isArray(sample.residents)
    && (index === 0 || sample.tick > samples[index - 1]!.tick)
    && sample.residents.every(({ residentId, position }) => SAFE_PROVIDER_ID.test(residentId) && validPosition(position)))) return null;

  const recipientIds = new Set(samples[0]!.residents
    .filter(({ residentId, position }) => residentId !== session.speakerId
      && distance3D(samples[0]!.speakerPosition, position) <= RESIDENT_HEARING_RADIUS)
    .map(({ residentId }) => residentId));
  for (const sample of samples.slice(1)) {
    const inRange = new Set(sample.residents
      .filter(({ residentId, position }) => residentId !== session.speakerId
        && distance3D(sample.speakerPosition, position) <= RESIDENT_HEARING_RADIUS)
      .map(({ residentId }) => residentId));
    for (const recipientId of recipientIds) if (!inRange.has(recipientId)) recipientIds.delete(recipientId);
  }
  if (recipientIds.size === 0) return null;

  return {
    type: 'resident.speech.perceived',
    eventId: `resident-speech:${createHash('sha256').update(responseKey).digest('base64url').slice(0, 32)}`,
    speakerId: session.speakerId,
    responseId: session.responseId,
    text: playbackReport.transcript,
    recipientIds: [...recipientIds],
    startedAtTick: samples[0]!.tick,
    completedAtTick: samples.at(-1)!.tick,
  };
}

function validPosition(position: Position3D): boolean {
  return Boolean(position && [position.x, position.y, position.z].every(Number.isFinite));
}
