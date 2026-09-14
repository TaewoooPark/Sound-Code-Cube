export const ROLES = ['kick', 'bass', 'snare', 'hats', 'percussion', 'chords', 'melody', 'texture'] as const;
export type Role = typeof ROLES[number];
export const BPM = 112;
export const STEPS_PER_CYCLE = 16;
export const PHRASE_STEPS = 32;
export type GenreId = 'deep-house' | 'techno' | 'uk-garage' | 'drum-and-bass' | 'trip-hop' | 'ambient' | 'electro' | 'dub';
export type ScaleName = 'minor' | 'major' | 'dorian' | 'pentatonic';
export interface MusicalProfile {
  id: GenreId;
  label: string;
  bpm: number;
  root: number;
  scale: ScaleName;
  key: string;
  sounds: Record<Role, string>;
}
export interface NoteEvent {
  step: number;
  note: number;
  velocity: number;
  duration: number;
}
export interface Loop {
  id: number;
  role: Role;
  sound: string;
  events: NoteEvent[];
  gain: number;
  pan: number;
  cutoff: number;
  tidal: string;
  source: 'codex' | 'local';
}
export interface AudioPulse {
  id: number;
  velocity: number;
  frequency: number;
  time: number;
  manual?: boolean;
}
export interface Composition {
  profile: MusicalProfile;
  bpm: number;
  key: string;
  loops: Loop[];
  source: 'codex' | 'local';
}
