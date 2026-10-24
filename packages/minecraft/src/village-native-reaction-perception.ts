import { createHash } from 'node:crypto';
import { distance3D, RESIDENT_HEARING_RADIUS, type Position3D } from './village-encounters.ts';
import type { NativeSpeechPositionSample } from './village-spoken-perception.ts';

const MAX_TRANSCRIPT_BYTES = 1_000;
const MAX_CONSUMED_REACTION_IDS = 512;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const SAFE_REACTION_ID = /^[A-Za-z0-9_-]{8,128}$/;

export interface NativeReactionHearingEvent {
  type: 'resident.speech.perceived';
  eventId: string;
  speakerId: string;
  responseId: string;
  text: string;
  recipientIds: readonly string[];
  startedAtTick: number;
  completedAtTick: number;
  origin: 'native-reaction';
  causalDepth: number;
}

/** Projects only completed, correlated reaction playback heard throughout the sampled interval. */
export function projectCompletedNativeReactionSpeech(input: {
  reaction: { reactionId: string; eventId: string; residentId: string; responseId: string; itemId: string; causalDepth: number };
  report: { reactionId: string; eventId: string; residentId: string; responseId: string; itemId: string; playback: 'completed' | 'interrupted'; transcript?: string };
  samples: readonly NativeSpeechPositionSample[];
  consumedReactionIds: Set<string>;
}): NativeReactionHearingEvent | null {
  const { reaction, report } = input;
  if (report.reactionId !== reaction.reactionId || report.eventId !== reaction.eventId
    || report.residentId !== reaction.residentId || report.responseId !== reaction.responseId
    || report.itemId !== reaction.itemId || !SAFE_REACTION_ID.test(reaction.reactionId)
    || !SAFE_ID.test(reaction.eventId) || !SAFE_ID.test(reaction.residentId)
    || !SAFE_ID.test(reaction.responseId) || !SAFE_ID.test(reaction.itemId)
    || !Number.isSafeInteger(reaction.causalDepth) || reaction.causalDepth < 1 || reaction.causalDepth > 2
    || input.consumedReactionIds.has(reaction.reactionId)) return null;

  if (input.consumedReactionIds.size >= MAX_CONSUMED_REACTION_IDS) {
    const oldest = input.consumedReactionIds.values().next().value as string | undefined;
    if (oldest !== undefined) input.consumedReactionIds.delete(oldest);
  }
  input.consumedReactionIds.add(reaction.reactionId);

  if (report.playback !== 'completed' || typeof report.transcript !== 'string' || !report.transcript.trim()
    || Buffer.byteLength(report.transcript, 'utf8') > MAX_TRANSCRIPT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(report.transcript)
    || input.samples.length < 2) return null;

  const samples = [...input.samples].sort((left, right) => left.tick - right.tick);
  if (!samples.every((sample, index) => Number.isSafeInteger(sample.tick) && sample.tick >= 0
    && validPosition(sample.speakerPosition) && Array.isArray(sample.residents)
    && (index === 0 || sample.tick > samples[index - 1]!.tick)
    && sample.residents.every(({ residentId, position }) => SAFE_ID.test(residentId) && validPosition(position)))) return null;

  const recipients = new Set(samples[0]!.residents
    .filter(({ residentId, position }) => residentId !== reaction.residentId
      && distance3D(samples[0]!.speakerPosition, position) <= RESIDENT_HEARING_RADIUS)
    .map(({ residentId }) => residentId));
  for (const sample of samples.slice(1)) {
    const inRange = new Set(sample.residents
      .filter(({ residentId, position }) => residentId !== reaction.residentId
        && distance3D(sample.speakerPosition, position) <= RESIDENT_HEARING_RADIUS)
      .map(({ residentId }) => residentId));
    for (const recipientId of recipients) if (!inRange.has(recipientId)) recipients.delete(recipientId);
  }
  if (recipients.size === 0) return null;

  const responseKey = `${reaction.reactionId}:${reaction.responseId}:${reaction.itemId}`;
  return {
    type: 'resident.speech.perceived',
    eventId: `native-reaction-speech:${createHash('sha256').update(responseKey).digest('base64url').slice(0, 32)}`,
    speakerId: reaction.residentId,
    responseId: reaction.responseId,
    text: report.transcript,
    recipientIds: [...recipients],
    startedAtTick: samples[0]!.tick,
    completedAtTick: samples.at(-1)!.tick,
    origin: 'native-reaction',
    causalDepth: reaction.causalDepth,
  };
}

function validPosition(position: Position3D): boolean {
  return Boolean(position && [position.x, position.y, position.z].every((coordinate) => Number.isFinite(coordinate)
    && Math.abs(coordinate) <= 1_000_000));
}
