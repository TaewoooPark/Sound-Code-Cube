import { BPM, PHRASE_STEPS, ROLES, type Composition, type GenreId, type Loop, type MusicalProfile, type NoteEvent, type Role } from './music';
import { isSupportedSound, scaleNote, seededRandom, selectProfile } from './profiles';
const PITCHED = new Set<Role>(['bass', 'chords', 'melody', 'texture']);
const decimal = (value: number) => Number(value.toFixed(6)).toString();

/** Compress repeated steps without changing the number or duration of events. */
function mini(tokens: string[]): string {
  const result: string[] = [];
  for (let index = 0; index < tokens.length;) {
    let end = index + 1;
    while (end < tokens.length && tokens[end] === tokens[index]) end++;
    const count = end - index;
    result.push(count >= 3 ? `${tokens[index]}!${count}` : Array(count).fill(tokens[index]).join(' '));
    index = end;
  }
  return result.join(' ');
}

/** Haskell TidalCycles, one 32-sixteenth-note phrase over two cycles.
 * `sustain` is expressed in seconds, matching NoteEvent.duration's step units.
 * Separate stack lanes retain simultaneous notes with independent velocities.
 * SuperDirt's dirt_gate applies gain^4; its fourth root preserves linear velocity.
 */
export function loopToTidal(loop: Omit<Loop, 'tidal'>, bpm = BPM): string {
  if (!isSupportedSound(loop.sound, loop.role)) throw new Error('Unsupported loop sound.');
  if (!Number.isFinite(bpm) || bpm < 60 || bpm > 180) throw new Error('Tempo must be 60–180 BPM.');
  const lanes: (NoteEvent | undefined)[][] = [];
  for (const event of [...loop.events].sort((a, b) => a.step - b.step || a.note - b.note)) {
    let lane = lanes.find(candidate => !candidate[event.step]);
    if (!lane) { lane = Array(PHRASE_STEPS).fill(undefined); lanes.push(lane); }
    lane[event.step] = event;
  }
  if (!lanes.length) return `d${loop.id + 1} $ silence`;
  const patterns = lanes.map(lane => {
    const notes = mini(lane.map(event => event ? String(event.note) : '~'));
    const sounds = mini(lane.map(event => event ? loop.sound : '~'));
    const gains = mini(lane.map(event => decimal(event ? (event.velocity * loop.gain) ** 0.25 : 0)));
    const durations = mini(lane.map(event => decimal(event ? event.duration * 60 / bpm / 4 : 0)));
    const source = PITCHED.has(loop.role) ? `midinote "${notes}" # s "${loop.sound}"` : `s "${sounds}"`;
    return `${source} # gain "${gains}" # sustain "${durations}"`;
  });
  const phrase = patterns.length === 1 ? patterns[0] : `stack [${patterns.join(', ')}]`;
  return `d${loop.id + 1} $ slow 2 $ ${phrase} # pan ${decimal((loop.pan + 1) / 2)} # cutoff ${decimal(loop.cutoff)}`;
}

interface Rhythm {
  kick: number[]; snare: number[]; hats: number[]; percussion: number[];
  bass: number[]; bassDuration: number;
  chords: number[]; chordDuration: number;
  melody: number[]; melodyDuration: number;
  texture: number[]; textureDuration: number;
}
const RHYTHMS: Record<GenreId, Rhythm> = {
  'deep-house': { kick: [0,4,8,12,16,20,24,28], snare: [4,12,20,28], hats: [2,6,10,14,18,22,26,30],
    percussion: [3,7,11,19,23,27], bass: [2,6,10,14,18,22,25,30], bassDuration: 1.5,
    chords: [2,10,18,26], chordDuration: 2.1, melody: [3,9,14,19,25,30], melodyDuration: 1.4, texture: [0,16], textureDuration: 10 },
  techno: { kick: [0,4,8,12,16,20,24,28], snare: [12,28], hats: [0,2,3,4,6,8,10,11,12,14,16,18,19,20,22,24,26,27,28,30],
    percussion: [3,7,11,15,19,23,27,31], bass: [0,2,3,6,8,10,11,14,16,18,19,22,24,26,27,30], bassDuration: 0.72,
    chords: [5,13,21,29], chordDuration: 0.8, melody: [1,5,9,13,17,21,25,29], melodyDuration: 0.55, texture: [7,23], textureDuration: 3 },
  'uk-garage': { kick: [0,7,10,16,22,26], snare: [4,12,20,28], hats: [0,3,6,8,11,14,16,19,22,24,27,30],
    percussion: [2,9,15,18,25,31], bass: [1,6,9,15,18,23,27,30], bassDuration: 1.2,
    chords: [3,11,19,27], chordDuration: 1.3, melody: [2,7,14,18,23,30], melodyDuration: 1.1, texture: [0,20], textureDuration: 7 },
  'drum-and-bass': { kick: [0,10,16,18,26], snare: [4,12,20,28], hats: [0,2,3,4,6,8,10,11,12,14,16,18,19,20,22,24,26,27,28,30],
    percussion: [7,15,23,31], bass: [0,6,10,16,22,26], bassDuration: 3.1,
    chords: [0,16], chordDuration: 12, melody: [5,13,21,29], melodyDuration: 2.4, texture: [0,18], textureDuration: 10 },
  'trip-hop': { kick: [0,6,11,16,23,26], snare: [4,12,20,28], hats: [2,5,8,10,14,18,21,24,27,30],
    percussion: [3,13,22,31], bass: [0,7,16,23], bassDuration: 4.5,
    chords: [0,12,20], chordDuration: 7.5, melody: [3,10,15,22,29], melodyDuration: 2.5, texture: [0,24], textureDuration: 9 },
  ambient: { kick: [0], snare: [24], hats: [7,19,30], percussion: [10,26], bass: [0,16], bassDuration: 13,
    chords: [0,16], chordDuration: 15, melody: [5,14,25], melodyDuration: 5, texture: [0,16], textureDuration: 15 },
  electro: { kick: [0,3,10,16,19,22,27], snare: [4,12,20,28], hats: [0,2,6,8,10,14,16,18,22,24,26,30],
    percussion: [6,11,14,22,27,30], bass: [0,3,6,10,14,16,19,22,26,30], bassDuration: 0.9,
    chords: [6,14,22,30], chordDuration: 0.75, melody: [1,4,7,11,17,20,23,27], melodyDuration: 0.65, texture: [0,15], textureDuration: 4 },
  dub: { kick: [8,24], snare: [8,24], hats: [2,6,10,14,18,22,26,30], percussion: [5,13,21,29],
    bass: [0,7,14,16,23,30], bassDuration: 4.2,
    chords: [2,6,10,14,18,22,26,30], chordDuration: 0.85, melody: [3,11,19,27], melodyDuration: 2.8, texture: [0,16], textureDuration: 12 },
};

/** Explicitly local score, with different grooves and assets for each musical family. */
export function createLocalComposition(seed = Date.now(), profile = selectProfile(seed)): Composition {
  const random = seededRandom(seed ^ 0x9e3779b9);
  const event = (step: number, note: number, velocity: number, duration: number): NoteEvent =>
    ({ step, note, velocity: Math.max(0.02, Math.min(1, Number(velocity.toFixed(3)))), duration: Number(duration.toFixed(3)) });
  const rhythm = RHYTHMS[profile.id];
  const airy = profile.id === 'ambient';
  const harmony = [0, [3, 4, 5][Math.floor(random() * 3)]];
  const harmonicAt = (step: number) => harmony[step < 16 ? 0 : 1];
  const contour = [[0,0,4,2,0,4,2,6], [0,2,4,0,0,6,4,2], [0,4,0,2,4,0,6,4]][Math.floor(random() * 3)];
  const drum = (steps: number[], note: number, peak: number, duration: number) => steps.map((step, index) =>
    event(step, note, peak * (index % 2 ? 0.84 : 1) * (0.92 + random() * 0.08), duration));
  const melodyShift = [0, 1, 2][Math.floor(random() * 3)];
  const shiftedMelody = rhythm.melody.map(step => (step + melodyShift) % 32).sort((a, b) => a - b);
  const musicalEvents: Record<Role, NoteEvent[]> = {
    kick: drum(rhythm.kick, 36, airy ? 0.28 : 0.94, airy ? 2 : 1.3),
    snare: drum(rhythm.snare, 38, airy ? 0.18 : 0.77, airy ? 2 : 1.2),
    hats: drum(rhythm.hats, 42, airy ? 0.16 : 0.46,
      profile.sounds.hats.includes('oh') ? 1.4 : 0.4),
    percussion: drum(rhythm.percussion, 45, airy ? 0.24 : 0.43, airy ? 3 : 0.75),
    bass: rhythm.bass.map((step, index) => event(step,
      scaleNote(profile, harmonicAt(step) + contour[index % contour.length]),
      airy ? 0.45 : 0.7 + random() * 0.12, rhythm.bassDuration * (0.9 + random() * 0.2))),
    chords: rhythm.chords.flatMap(step => (profile.scale === 'pentatonic' ? [0,2,4] : [0,2,4,6])
      .map((degree, index) => event(step, scaleNote(profile, harmonicAt(step) + degree, 1),
        (airy ? 0.43 : 0.38) - index * 0.035, rhythm.chordDuration))),
    melody: shiftedMelody.map((step, index) => event(step,
      scaleNote(profile, harmonicAt(step) + contour[(index + 2) % contour.length], 2),
      0.3 + random() * 0.16, rhythm.melodyDuration * (0.85 + random() * 0.3))),
    texture: rhythm.texture.map(step => event(step, scaleNote(profile, harmonicAt(step) + 4, 2),
      airy ? 0.27 : 0.17, rhythm.textureDuration)),
  };
  if (profile.id === 'drum-and-bass') musicalEvents.snare.push(...drum([7,15,23,31], 38, 0.18, 0.5));
  if (profile.id === 'electro' && random() > 0.5) musicalEvents.kick.push(event(30, 36, 0.43, 1));
  const gains = airy ? [0.4, 0.48, 0.22, 0.2, 0.32, 0.62, 0.48, 0.55] : [0.78, 0.65, 0.56, 0.43, 0.5, 0.48, 0.47, 0.38];
  const pans = [0, 0, -0.05, 0.28, -0.34, -0.15, 0.22, 0.05];
  const dark = profile.id === 'trip-hop' || profile.id === 'dub';
  const cutoffs = [15000, profile.sounds.bass === 'sccacid' ? 3800 : 1400, dark ? 6500 : 15000,
    dark ? 8500 : 18000, 9500, airy ? 5800 : dark ? 2700 : 4200, 6500, 4800];
  const loops = ROLES.map((role, id): Loop => {
    const loop = { id, role, sound: profile.sounds[role], events: musicalEvents[role].sort((a, b) => a.step - b.step),
      gain: gains[id], pan: pans[id], cutoff: cutoffs[id], source: 'local' as const };
    return { ...loop, tidal: loopToTidal(loop, profile.bpm) };
  });
  return { profile, bpm: profile.bpm, key: profile.key, loops, source: 'local' };
}
