import { VillageHeardSpeechMemory } from './village-heard-speech-memory.ts';
import { projectCompletedPlayerSpeech, type NativePlayerSpeechPositionSample, type TransientPlayerSpeechPerception } from './village-player-speech-perception.ts';

export interface NativePlayerSpeechTurn {
  turnId: string;
  residentSessionId?: string;
  playerSpeechSamples?: NativePlayerSpeechPositionSample[];
  playerSpeechSamplingComplete?: boolean;
  playerSpeechItems?: Array<{ itemId: string; transcript: string }>;
  playerSpeechItemIds?: Set<string>;
}

export interface NativePlayerSpeechCommand {
  turnId: string;
  residentSessionId: string;
  itemId: string;
  transcript: string;
}

export type NativePlayerSpeechAckStatus = 'no_session' | 'duplicate' | 'too_many' | 'queued';

/** Shared production handler for provider-final transcripts carried by one held resident session. */
export class NativePlayerSpeechHandler {
  readonly #memory: VillageHeardSpeechMemory;
  readonly #maxItemsPerTurn: number;
  readonly #consumedItemIds = new Map<string, Set<string>>();

  constructor(memory: VillageHeardSpeechMemory, maxItemsPerTurn = 8) {
    this.#memory = memory;
    this.#maxItemsPerTurn = Number.isSafeInteger(maxItemsPerTurn) ? Math.max(1, Math.min(32, maxItemsPerTurn)) : 8;
  }

  finish(turn: NativePlayerSpeechTurn | undefined, command: NativePlayerSpeechCommand): NativePlayerSpeechAckStatus {
    if (!turn || turn.turnId !== command.turnId || turn.residentSessionId !== command.residentSessionId) return 'no_session';
    const itemIds = turn.playerSpeechItemIds ?? new Set<string>();
    turn.playerSpeechItemIds = itemIds;
    if (itemIds.has(command.itemId)) return 'duplicate';
    if ((turn.playerSpeechItems?.length ?? 0) >= this.#maxItemsPerTurn) return 'too_many';
    turn.playerSpeechItems = [...(turn.playerSpeechItems ?? []), { itemId: command.itemId, transcript: command.transcript }];
    itemIds.add(command.itemId);
    return 'queued';
  }

  complete(turn: NativePlayerSpeechTurn): TransientPlayerSpeechPerception[] {
    const items = turn.playerSpeechItems ?? [];
    turn.playerSpeechItems = [];
    turn.playerSpeechItemIds?.clear();
    if (!turn.playerSpeechSamplingComplete || !turn.residentSessionId) return [];

    const consumedItemIds = this.#consumedItemIds.get(turn.residentSessionId) ?? new Set<string>();
    this.#consumedItemIds.set(turn.residentSessionId, consumedItemIds);
    const perceptions: TransientPlayerSpeechPerception[] = [];
    for (const item of items) {
      const event = projectCompletedPlayerSpeech({
        session: { turnId: turn.turnId, sessionId: turn.residentSessionId, itemId: item.itemId },
        report: { turnId: turn.turnId, sessionId: turn.residentSessionId, itemId: item.itemId, transcript: item.transcript },
        samples: turn.playerSpeechSamples ?? [], consumedItemIds,
      });
      if (event) {
        this.#memory.remember(event, 'the player');
        perceptions.push(event);
      }
    }
    return perceptions;
  }

  clear(): void {
    this.#consumedItemIds.clear();
  }
}
