export interface VillageDialogueEvent {
  type: 'village.dialogue';
  speakerId: string;
  speakerName: string;
  line: string;
  position: { x: number; y: number; z: number };
  listenerId?: string;
  listenerName?: string;
  timestamp: number;
}

export function createVillageDialogueEvent(input: {
  speakerId: string;
  speakerName: string;
  line: string;
  position: { x: number; y: number; z: number };
  listenerId?: string;
  listenerName?: string;
  timestamp?: number;
}): VillageDialogueEvent {
  return {
    type: 'village.dialogue',
    speakerId: input.speakerId,
    speakerName: input.speakerName,
    line: input.line,
    position: { ...input.position },
    ...(input.listenerId ? { listenerId: input.listenerId } : {}),
    ...(input.listenerName ? { listenerName: input.listenerName } : {}),
    timestamp: input.timestamp ?? Date.now(),
  };
}
