export interface RoutineStop {
  id: string;
  place: string;
  offset: readonly [number, number];
}

export interface VillagerProfile {
  id: string;
  username: string;
  role: string;
  routine: readonly RoutineStop[];
  pauseMs: number;
}

export interface DialogueTurn {
  speakerId: string;
  listenerId: string;
  stopId: string;
  line: string;
}

export interface MysteryTurn extends DialogueTurn { clueId: string }

export const villageProfiles: readonly VillagerProfile[] = [
  {
    id: 'mira',
    username: 'MiraGardener',
    role: 'gardener',
    routine: [
      { id: 'west-garden', place: 'west garden', offset: [5, 2] },
      { id: 'market-well', place: 'market well', offset: [2, -1] },
      { id: 'seed-shed', place: 'seed shed', offset: [7, 4] },
    ],
    pauseMs: 12_000,
  },
  {
    id: 'tobin',
    username: 'TobinCart',
    role: 'cartographer',
    routine: [
      { id: 'map-board', place: 'map board', offset: [-5, 2] },
      { id: 'river-gate', place: 'river gate', offset: [-8, 0] },
      { id: 'market-well', place: 'market well', offset: [2, -1] },
    ],
    pauseMs: 16_000,
  },
  {
    id: 'pip',
    username: 'PipBaker',
    role: 'baker',
    routine: [
      { id: 'bakery-hearth', place: 'bakery hearth', offset: [0, -6] },
      { id: 'market-well', place: 'market well', offset: [2, -1] },
      { id: 'grain-store', place: 'grain store', offset: [-2, -7] },
    ],
    pauseMs: 20_000,
  },
];

/** Authored turn order keeps conversations reproducible and lets residents refer to shared events. */
export const villageDialogue: readonly DialogueTurn[] = [
  { speakerId: 'mira', listenerId: 'pip', stopId: 'seed-shed', line: 'Pip, the west wheat is ready after last night’s rain.' },
  { speakerId: 'pip', listenerId: 'mira', stopId: 'bakery-hearth', line: 'Then I can bake the extra loaf you promised the seed keepers.' },
  { speakerId: 'tobin', listenerId: 'mira', stopId: 'river-gate', line: 'Mira, I marked the flooded river bend on the map board.' },
  { speakerId: 'mira', listenerId: 'tobin', stopId: 'west-garden', line: 'I saw the water too; I’ll move the seedlings uphill before dusk.' },
  { speakerId: 'pip', listenerId: 'tobin', stopId: 'grain-store', line: 'Tobin, your dry trail map brought the grain cart through safely.' },
  { speakerId: 'tobin', listenerId: 'pip', stopId: 'map-board', line: 'Good. I’ll add your bakery as the next stop before the bridge.' },
  { speakerId: 'mira', listenerId: 'pip', stopId: 'market-well', line: 'The new seedlings are safe uphill; I saved a basket of wheat for your next batch.' },
  { speakerId: 'tobin', listenerId: 'mira', stopId: 'market-well', line: 'I added that higher garden path to the map after seeing your seedlings there.' },
  { speakerId: 'pip', listenerId: 'mira', stopId: 'market-well', line: 'I’ll use that basket for tomorrow’s bread; the seed keepers will get the first loaf.' },
];

/** Fictional, immutable evidence beats. Models never receive culprit or undiscovered clues. */
export const villageMysteryDialogue: readonly MysteryTurn[] = [
  { speakerId: 'mira', listenerId: 'tobin', stopId: 'west-garden', clueId: 'silent-bell', line: 'The dawn bell stayed quiet again. Rowan never missed a morning.' },
  { speakerId: 'tobin', listenerId: 'pip', stopId: 'map-board', clueId: 'flour-ledger', line: 'The flour ledger is short by two sacks. I have not named anyone.' },
  { speakerId: 'tobin', listenerId: 'mira', stopId: 'river-gate', clueId: 'route-mark', line: 'A flour cart passed the bell-house path. My map shows the turn, not its driver.' },
  { speakerId: 'pip', listenerId: 'tobin', stopId: 'bakery-hearth', clueId: 'pip-denial', line: 'I stayed in the bakery all night. The ovens were cold until morning.' },
  { speakerId: 'mira', listenerId: 'pip', stopId: 'seed-shed', clueId: 'mira-sighting', line: 'Before dawn I saw you return by the garden path. I was afraid to say so.' },
  { speakerId: 'pip', listenerId: 'mira', stopId: 'bakery-hearth', clueId: 'pip-contradiction', line: 'I only returned to the bakery after dawn, when I relit the hearth.' },
];
