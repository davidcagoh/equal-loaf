export interface VillagerProfile {
  username: string;
  role: string;
  offset: readonly [number, number];
  lines: readonly string[];
  pauseMs: number;
}

export const villageProfiles: readonly VillagerProfile[] = [
  {
    username: 'MiraGardener',
    role: 'gardener',
    offset: [5, 2],
    lines: ['The west beds need tending before dusk.', 'I saved the best seeds for next season.'],
    pauseMs: 18_000,
  },
  {
    username: 'TobinCart',
    role: 'cartographer',
    offset: [-5, 2],
    lines: ['I marked the river bend on my map.', 'There is a quiet trail beyond the hill.'],
    pauseMs: 24_000,
  },
  {
    username: 'PipBaker',
    role: 'baker',
    offset: [0, -6],
    lines: ['Fresh bread is cooling by the hearth.', 'Bring wheat tomorrow and I will bake extra.'],
    pauseMs: 30_000,
  },
];
