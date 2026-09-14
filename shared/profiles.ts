import { ROLES, type GenreId, type MusicalProfile, type Role, type ScaleName } from './music';

export const GENRE_IDS = ['deep-house', 'techno', 'uk-garage', 'drum-and-bass', 'trip-hop', 'ambient', 'electro', 'dub'] as const;
export const SAMPLE_BANK_COUNTS = { bd: 24, '808bd': 25, '909': 1, sd: 2, '808sd': 25,
  hh: 13, '808hc': 5, '808oh': 5, cp: 2, perc: 6, tabla: 26, glitch: 8, metal: 10,
  sn: 52, jazz: 8, east: 9, tink: 5 } as const;
export const SYNTH_SOUNDS = ['sccbass', 'sccchords', 'sccmelody', 'scctexture',
  'sccacid', 'sccpluck', 'sccbell', 'sccpad', 'sccorgan', 'sccfm'] as const;
export const SCALE_INTERVALS: Record<ScaleName, readonly number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], pentatonic: [0, 3, 5, 7, 10],
};

export interface ProfileDefinition {
  id: GenreId;
  label: string;
  bpmRange: readonly [number, number];
  scales: readonly ScaleName[];
  direction: string;
  soundOptions: Record<Role, readonly string[]>;
}

const kit = (kick: string[], bass: string[], snare: string[], hats: string[], percussion: string[],
  chords: string[], melody: string[], texture: string[]): Record<Role, readonly string[]> =>
  ({ kick, bass, snare, hats, percussion, chords, melody, texture });

export const PROFILES: readonly ProfileDefinition[] = [
  { id: 'deep-house', label: 'Deep house', bpmRange: [116, 126], scales: ['minor', 'major', 'dorian'],
    direction: 'Four-on-the-floor house; warm offbeat organ stabs, rounded syncopated bass, open hats and restrained melodic hooks.',
    soundOptions: kit(['bd:3', 'bd:7', '909:0'], ['sccbass'], ['cp:0', 'cp:1'], ['808oh:1', 'hh:0'],
      ['perc:1', 'tabla:13'], ['sccorgan', 'sccfm'], ['sccpluck', 'sccmelody'], ['sccpad']) },
  { id: 'techno', label: 'Techno', bpmRange: [130, 142], scales: ['minor'],
    direction: 'Driving warehouse techno; insistent kicks, clipped acid sequences, metallic ticks, repetitive tension and very sparse harmony.',
    soundOptions: kit(['909:0', 'bd:15', 'bd:20'], ['sccacid'], ['808sd:18', 'sd:0'], ['808hc:3', '808hc:4'],
      ['metal:4', 'glitch:1', 'metal:8'], ['sccpluck'], ['sccacid', 'sccfm'], ['scctexture', 'sccfm']) },
  { id: 'uk-garage', label: 'UK garage', bpmRange: [128, 136], scales: ['minor', 'dorian'],
    direction: 'Two-step UK garage; broken kicks, skipping hats, syncopated sub phrases, clipped jazzy chords and call-and-response bell motifs.',
    soundOptions: kit(['808bd:7', 'bd:10'], ['sccbass', 'sccfm'], ['cp:1', '808sd:10'], ['808hc:1', 'hh:3'],
      ['perc:3', 'east:0'], ['sccfm', 'sccorgan'], ['sccbell', 'sccpluck'], ['sccpad']) },
  { id: 'drum-and-bass', label: 'Drum and bass', bpmRange: [164, 174], scales: ['minor'],
    direction: 'Fast drum and bass; broken kick/snare accents, fast rolling hats and ghost snares, long bass answers, atmospheric suspended chords.',
    soundOptions: kit(['jazz:0', 'bd:18'], ['sccbass', 'sccacid'], ['sn:16', 'sn:35', 'sd:0'], ['hh:3', '808hc:2'],
      ['glitch:1', 'perc:4'], ['sccpad'], ['sccfm', 'sccbell'], ['scctexture']) },
  { id: 'trip-hop', label: 'Trip hop', bpmRange: [78, 94], scales: ['minor', 'pentatonic'],
    direction: 'Slow dusty trip hop; loping broken drums, low rounded bass, sparse jazzy electric keys, understated plucked melody and dark space.',
    soundOptions: kit(['jazz:0', 'bd:2'], ['sccbass'], ['jazz:7', '808sd:4'], ['jazz:3', 'hh:0'],
      ['tabla:3', 'perc:0', 'east:1'], ['sccfm', 'sccchords'], ['sccpluck', 'sccmelody'], ['scctexture']) },
  { id: 'ambient', label: 'Ambient', bpmRange: [64, 82], scales: ['major', 'dorian', 'pentatonic'],
    direction: 'Beat-sparse ambient; isolated low pulses, long evolving pads, open fifths, slow bell droplets, breathing silence and delicate metallic texture.',
    soundOptions: kit(['808bd:20'], ['sccpad', 'sccbass'], ['perc:2', 'sd:1'], ['808oh:4'],
      ['tink:1', 'metal:2', 'tabla:15'], ['sccpad'], ['sccbell', 'sccpluck'], ['sccpad', 'scctexture']) },
  { id: 'electro', label: 'Electro', bpmRange: [112, 128], scales: ['minor', 'major', 'pentatonic'],
    direction: 'Syncopated machine-funk electro; classic 808 drum voices, angular bass jumps, short robotic FM motifs, rhythmic chord punctuations.',
    soundOptions: kit(['808bd:3', '808bd:12'], ['sccacid', 'sccbass'], ['808sd:8', '808sd:16'], ['808hc:0', '808oh:0'],
      ['glitch:1', 'perc:5'], ['sccorgan', 'sccpluck'], ['sccfm', 'sccbell'], ['scctexture']) },
  { id: 'dub', label: 'Dub', bpmRange: [70, 88], scales: ['minor', 'dorian'],
    direction: 'Spacious dub; one-drop and half-time drum placement, very deep sustained bass, offbeat organ skanks, sparse woody percussion and bell echoes.',
    soundOptions: kit(['bd:5', '808bd:22'], ['sccbass'], ['808sd:2', 'cp:0'], ['808hc:2', 'hh:0'],
      ['tabla:9', 'east:0', 'perc:2'], ['sccorgan'], ['sccbell', 'sccpluck'], ['sccpad']) },
];

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let mixed = Math.imul(state ^ state >>> 15, state | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

export function selectProfile(seed: number, genre?: GenreId | 'auto'): MusicalProfile {
  const random = seededRandom(seed);
  const definition = genre && genre !== 'auto' ? PROFILES.find(profile => profile.id === genre) : PROFILES[Math.floor(random() * PROFILES.length)];
  if (!definition) throw new Error('Unknown musical genre.');
  const root = 36 + Math.floor(random() * 12);
  const scale = definition.scales[Math.floor(random() * definition.scales.length)];
  const bpm = definition.bpmRange[0] + Math.floor(random() * (definition.bpmRange[1] - definition.bpmRange[0] + 1));
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const sounds = Object.fromEntries(ROLES.map(role => {
    const options = definition.soundOptions[role];
    return [role, options[Math.floor(random() * options.length)]];
  })) as Record<Role, string>;
  return { id: definition.id, label: definition.label, bpm, root, scale, key: `${names[root % 12]} ${scale}`, sounds };
}

export function isSupportedSound(sound: unknown, role?: Role): sound is string {
  if (typeof sound !== 'string') return false;
  const synth = (SYNTH_SOUNDS as readonly string[]).includes(sound);
  const drumRole = role !== undefined && ['kick', 'snare', 'hats', 'percussion'].includes(role);
  if (synth) return !drumRole;
  if (role !== undefined && !drumRole) return false;
  const match = /^([a-z0-9]+):(\d+)$/.exec(sound);
  if (!match || !(match[1] in SAMPLE_BANK_COUNTS)) return false;
  return Number(match[2]) < SAMPLE_BANK_COUNTS[match[1] as keyof typeof SAMPLE_BANK_COUNTS];
}

export function scaleNote(profile: MusicalProfile, degree: number, octave = 0): number {
  const scale = SCALE_INTERVALS[profile.scale];
  const index = ((degree % scale.length) + scale.length) % scale.length;
  return Math.max(24, Math.min(96, profile.root + octave * 12 + Math.floor(degree / scale.length) * 12 + scale[index]));
}
