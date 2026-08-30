// Character roster — the real multipliers live server-side
// (spacetimedb/src/index.ts CHAR_STATS, same order); this is the
// presentation data. `stats` are 1–5 pips mirroring that table's
// multipliers, column by column.
export type HairStyle =
  | 'short' | 'buzz' | 'spiky' | 'ponytail' | 'bob'
  // wacky roster headgear/features (built in render.ts buildHair)
  | 'peel' | 'corgi' | 'antenna' | 'antennae' | 'slick' | 'tricorn'
  | 'shag' | 'bun' | 'afro' | 'tentacles' | 'flower' | 'wizard';

// Face texture variants (drawn in render.ts makeFaceTexture); omitted = human.
export type FaceStyle = 'human' | 'toon' | 'robot' | 'snout' | 'fangs' | 'patch' | 'specs';

// Full body builds (render.ts buildBody); omitted = the standard athlete.
export type BodyStyle =
  | 'athlete' | 'banana' | 'corgi' | 'robot' | 'alien' | 'vampire' | 'pirate'
  | 'yeti' | 'granny' | 'disco' | 'octopus' | 'cactus' | 'wizard';

export interface CharStats {
  speed: number; // run speed
  power: number; // shot power
  stamina: number; // sprint reserve and how fast it comes back
  curl: number; // bend on the ball
  accuracy: number; // shrinks scuffed-pass drift
  tackle: number; // slide tackle reach and success
}

export const STAT_LABELS: [keyof CharStats, string][] = [
  ['speed', 'SPD'],
  ['power', 'POW'],
  ['stamina', 'STA'],
  ['curl', 'CRL'],
  ['accuracy', 'ACC'],
  ['tackle', 'TCK'],
];

export interface Character {
  id: number;
  name: string;
  country: string;
  flag: string;
  style: string;
  color: number; // shirt color (renderer)
  css: string; // same color for DOM
  skin: number; // skin tone (renderer)
  hair: number; // hair color (renderer)
  hairStyle: HairStyle;
  eyes: string; // iris color (face texture)
  face?: FaceStyle; // face texture variant (default 'human')
  body?: BodyStyle; // full body build (default 'athlete')
  // body-shape overrides multiplied onto the stat-derived physique —
  // stubby corgi legs, octopus arms, yeti bulk (default 1 each)
  physique?: { legs?: number; arms?: number; bulk?: number };
  stats: CharStats;
}

export const CHARACTERS: Character[] = [
  { id: 0, name: 'BLAZE', country: 'USA', flag: '🇺🇸', style: 'POWER STRIKER', color: 0xe03028, css: '#e03028', skin: 0xc9895c, hair: 0x4a2a12, hairStyle: 'short', eyes: '#4a2f1d',
    stats: { speed: 3, power: 5, stamina: 5, curl: 1, accuracy: 1, tackle: 2 } },
  { id: 1, name: 'VOLT', country: 'GBR', flag: '🇬🇧', style: 'BALL WINNER', color: 0x2858e0, css: '#2858e0', skin: 0xf2c9a2, hair: 0xc9973f, hairStyle: 'short', eyes: '#3d6bb0',
    stats: { speed: 1, power: 3, stamina: 2, curl: 3, accuracy: 4, tackle: 5 } },
  { id: 2, name: 'KAI', country: 'JPN', flag: '🇯🇵', style: 'SPEED DEMON', color: 0x00b8a8, css: '#00b8a8', skin: 0xe8b184, hair: 0x1a1414, hairStyle: 'spiky', eyes: '#2a1e16',
    stats: { speed: 5, power: 1, stamina: 1, curl: 4, accuracy: 4, tackle: 1 } },
  { id: 3, name: 'ROSA', country: 'ESP', flag: '🇪🇸', style: 'PLAYMAKER', color: 0xf08018, css: '#f08018', skin: 0xcf9166, hair: 0x33190d, hairStyle: 'ponytail', eyes: '#4a2f1d',
    stats: { speed: 2, power: 4, stamina: 2, curl: 2, accuracy: 5, tackle: 1 } },
  { id: 4, name: 'VIPER', country: 'AUS', flag: '🇦🇺', style: 'ALL-ROUNDER', color: 0x28a028, css: '#28a028', skin: 0x8a563a, hair: 0x14100d, hairStyle: 'buzz', eyes: '#241a12',
    stats: { speed: 4, power: 4, stamina: 3, curl: 3, accuracy: 2, tackle: 3 } },
  { id: 5, name: 'LUNA', country: 'FRA', flag: '🇫🇷', style: 'TRICK ARTIST', color: 0x9040d0, css: '#9040d0', skin: 0xf4d6b6, hair: 0x2c2138, hairStyle: 'bob', eyes: '#5a3d8a',
    stats: { speed: 2, power: 2, stamina: 1, curl: 5, accuracy: 3, tackle: 2 } },
  // --- the wacky roster (see ROSTER.md) — unlockable-ready ----------------
  { id: 6, name: 'PEELS', country: 'BAN', flag: '🍌', style: 'SLIPPERY WINGER', color: 0x6b4423, css: '#6b4423', skin: 0xf5d130, hair: 0xf0c437, body: 'banana', hairStyle: 'peel', eyes: '#4a3210',
    stats: { speed: 2, power: 2, stamina: 2, curl: 5, accuracy: 2, tackle: 2 } },
  { id: 7, name: 'BISCUIT', country: 'PEM', flag: '🐶', style: 'GOOD BOY', color: 0xd6284f, css: '#d6284f', skin: 0xd9924a, hair: 0xd9924a, body: 'corgi', hairStyle: 'corgi', eyes: '#33200f', face: 'snout',
    physique: { legs: 0.8, arms: 0.85, bulk: 1.06 },
    stats: { speed: 5, power: 2, stamina: 1, curl: 2, accuracy: 5, tackle: 1 } },
  { id: 8, name: 'SERVO', country: 'LAB', flag: '🤖', style: 'GOAL MACHINE', color: 0x8395a7, css: '#8395a7', skin: 0x9aa4b2, hair: 0x5a6470, body: 'robot', hairStyle: 'antenna', eyes: '#ff3b3b', face: 'robot',
    stats: { speed: 2, power: 4, stamina: 5, curl: 1, accuracy: 4, tackle: 1 } },
  { id: 9, name: 'ZORP', country: 'ZG9', flag: '👽', style: 'COSMIC CONTROL', color: 0xd648d0, css: '#d648d0', skin: 0x7ed957, hair: 0x5cb544, body: 'alien', hairStyle: 'antennae', eyes: '#0c0c0c', face: 'toon',
    stats: { speed: 3, power: 2, stamina: 1, curl: 4, accuracy: 5, tackle: 1 } },
  { id: 10, name: 'SMASHULA', country: 'TRV', flag: '🦇', style: 'MIDNIGHT POACHER', color: 0x5d1830, css: '#5d1830', skin: 0xe4e9f0, hair: 0x14101c, body: 'vampire', hairStyle: 'slick', eyes: '#c01a3f', face: 'fangs',
    stats: { speed: 3, power: 4, stamina: 4, curl: 3, accuracy: 2, tackle: 1 } },
  { id: 11, name: 'PLANK', country: 'ARR', flag: '🏴‍☠️', style: 'CANNONBALL POWER', color: 0x203a63, css: '#203a63', skin: 0xb97a4e, hair: 0x1c1208, body: 'pirate', hairStyle: 'tricorn', eyes: '#2a1c10', face: 'patch',
    stats: { speed: 2, power: 5, stamina: 2, curl: 3, accuracy: 2, tackle: 2 } },
  { id: 12, name: 'YETI', country: 'HIM', flag: '❄️', style: 'ABOMINABLE WALL', color: 0x35c4e8, css: '#35c4e8', skin: 0xf2f6fb, hair: 0xe8f0f8, body: 'yeti', hairStyle: 'shag', eyes: '#3f7fc4', face: 'toon',
    physique: { bulk: 1.12 },
    stats: { speed: 1, power: 5, stamina: 2, curl: 2, accuracy: 2, tackle: 5 } },
  { id: 13, name: 'GRANNY', country: 'NAN', flag: '👵', style: 'CRAFTY PLACEMENT', color: 0xba68c8, css: '#ba68c8', skin: 0xe9c6a5, hair: 0xd7d9dd, body: 'granny', hairStyle: 'bun', eyes: '#57708c', face: 'specs',
    physique: { legs: 0.94 },
    stats: { speed: 1, power: 2, stamina: 2, curl: 4, accuracy: 5, tackle: 2 } },
  { id: 14, name: 'DISCO', country: 'FNK', flag: '🪩', style: 'FUNKY FOOTWORK', color: 0xd4af37, css: '#d4af37', skin: 0x8a563a, hair: 0x211712, body: 'disco', hairStyle: 'afro', eyes: '#2c1d12',
    stats: { speed: 4, power: 4, stamina: 1, curl: 3, accuracy: 2, tackle: 2 } },
  { id: 15, name: 'INKY', country: 'ABY', flag: '🐙', style: 'EIGHT-ARM KEEPER', color: 0x0f6f8f, css: '#0f6f8f', skin: 0x9b59b6, hair: 0x8447a8, body: 'octopus', hairStyle: 'tentacles', eyes: '#101010', face: 'toon',
    physique: { arms: 1.12 },
    stats: { speed: 2, power: 2, stamina: 2, curl: 3, accuracy: 2, tackle: 5 } },
  { id: 16, name: 'PRICKLES', country: 'SAG', flag: '🌵', style: 'SPIKY DEFENDER', color: 0xd9a441, css: '#d9a441', skin: 0x3f9b4f, hair: 0xf06292, body: 'cactus', hairStyle: 'flower', eyes: '#233a18',
    physique: { arms: 0.9 },
    stats: { speed: 1, power: 4, stamina: 5, curl: 2, accuracy: 2, tackle: 4 } },
  { id: 17, name: 'MYSTO', country: 'ARC', flag: '🧙', style: 'CURL SORCERER', color: 0x3d2b8f, css: '#3d2b8f', skin: 0xf2c9a2, hair: 0xb9bdd4, body: 'wizard', hairStyle: 'wizard', eyes: '#7a4ad0',
    stats: { speed: 2, power: 2, stamina: 2, curl: 5, accuracy: 4, tackle: 1 } },
];

export interface Pitch {
  id: number;
  name: string;
  desc: string;
  css: string;
}

// Order matches the server's PITCHES friction/bounce table.
export const PITCHES: Pitch[] = [
  { id: 0, name: 'GRASS', desc: 'DAYLIGHT · TRUE BOUNCE', css: '#46a337' },
  { id: 1, name: 'NIGHT', desc: 'FLOODLIT · SLICK TURF', css: '#1f6b32' },
  { id: 2, name: 'STREET', desc: 'CONCRETE · GRIPPY & LIVELY', css: '#8a8f96' },
];
