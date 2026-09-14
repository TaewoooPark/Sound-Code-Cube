import { BPM, ROLES, type Composition, type GenreId, type Loop, type MusicalProfile, type NoteEvent } from '../shared/music.ts';
import { loopToTidal } from '../shared/patterns.ts';
import { GENRE_IDS, PROFILES, SCALE_INTERVALS, isSupportedSound } from '../shared/profiles.ts';

export class BridgeError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError(400, 'INVALID_INPUT', 'Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, field: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new BridgeError(400, 'INVALID_INPUT', `Invalid ${field}.`);
  }
  return value;
}

export function parseSeed(value: unknown): number {
  return value === undefined ? Math.floor(Math.random() * 0x7fffffff) : number(value, 'seed', 0, 0xffffffff, true);
}

export function parseId(value: unknown): number {
  return number(value, 'id', 0, 7, true);
}

export function parseBpm(value: unknown, defaultBpm = BPM): number {
  return value === undefined ? defaultBpm : number(value, 'bpm', 60, 180, true);
}

export function parseGenre(value: unknown): GenreId | 'auto' {
  if (value === undefined || value === 'auto') return 'auto';
  if (typeof value !== 'string' || !(GENRE_IDS as readonly string[]).includes(value)) throw new BridgeError(400, 'INVALID_INPUT', 'Unknown musical genre.');
  return value as GenreId;
}

/** Recover musical context from bounded canonical fields, never from user descriptions. */
export function parseProfile(value: unknown): MusicalProfile {
  const input = record(value);
  const genre = parseGenre(input.id);
  const definition = PROFILES.find(profile => profile.id === genre);
  if (!definition) throw new BridgeError(400, 'INVALID_INPUT', 'A concrete musical profile is required.');
  const bpm = parseBpm(input.bpm);
  const root = number(input.root, 'profile.root', 36, 47, true);
  const scale = input.scale as MusicalProfile['scale'];
  if (!definition.scales.includes(scale) || !(scale in SCALE_INTERVALS)) throw new BridgeError(400, 'INVALID_INPUT', 'Invalid musical scale.');
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const key = `${names[root % 12]} ${scale}`;
  if (input.key !== key) throw new BridgeError(400, 'INVALID_INPUT', 'The musical key must match its root and scale.');
  const inputSounds = record(input.sounds);
  const sounds = Object.fromEntries(ROLES.map(role => {
    const sound = inputSounds[role];
    if (!isSupportedSound(sound, role) || !definition.soundOptions[role].includes(sound)) throw new BridgeError(400, 'INVALID_INPUT', `Invalid ${role} instrument for this genre.`);
    return [role, sound];
  })) as MusicalProfile['sounds'];
  return { id: definition.id, label: definition.label, bpm, root, scale, key, sounds };
}

function parseEvent(value: unknown): NoteEvent {
  const input = record(value);
  return {
    step: number(input.step, 'event.step', 0, 31, true),
    note: number(input.note, 'event.note', 24, 96, true),
    velocity: number(input.velocity, 'event.velocity', 0.02, 1),
    duration: number(input.duration, 'event.duration', 0.25, 32),
  };
}

/** Only these bounded numeric fields reach the Haskell renderer. Input code is discarded. */
export function parseLoop(value: unknown, source: Loop['source'] = 'codex', expectedId?: number, bpm = BPM, assignedSound?: string): Loop {
  const input = record(value);
  const id = parseId(input.id);
  if ((expectedId !== undefined && id !== expectedId) || input.role !== ROLES[id]) {
    throw new BridgeError(400, 'INVALID_INPUT', 'Loop role must match its vertex id.');
  }
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 64) {
    throw new BridgeError(400, 'INVALID_INPUT', 'A loop needs 1–64 note events.');
  }
  const events = input.events.map(parseEvent).sort((a, b) => a.step - b.step || a.note - b.note);
  const unique = new Set(events.map(event => `${event.step}:${event.note}`));
  if (unique.size !== events.length) throw new BridgeError(400, 'INVALID_INPUT', 'Duplicate note events.');
  const sound = assignedSound ?? input.sound;
  if (!isSupportedSound(sound, ROLES[id])) throw new BridgeError(400, 'INVALID_INPUT', 'Unsupported instrument or sample index.');
  const loop = {
    id,
    role: ROLES[id],
    sound,
    events,
    gain: number(input.gain, 'gain', 0.02, 1),
    pan: number(input.pan, 'pan', -1, 1),
    cutoff: number(input.cutoff, 'cutoff', 100, 18000),
    source,
  };
  return { ...loop, tidal: loopToTidal(loop, bpm) };
}

export function parseLoops(value: unknown, source: Loop['source'] = 'codex', complete = false, bpm = BPM, profile?: MusicalProfile): Loop[] {
  if (!Array.isArray(value) || value.length > 8 || (complete && value.length !== 8)) {
    throw new BridgeError(400, 'INVALID_INPUT', 'Expected at most eight unique loops.');
  }
  const loops = value.map(loop => {
    const input = record(loop);
    const id = parseId(input.id);
    return parseLoop(loop, source, id, bpm, profile?.sounds[ROLES[id]]);
  }).sort((a, b) => a.id - b.id);
  if (new Set(loops.map(loop => loop.id)).size !== loops.length) {
    throw new BridgeError(400, 'INVALID_INPUT', 'Loop ids must be unique.');
  }
  return loops;
}

export function parseComposition(value: unknown, assignedProfile?: MusicalProfile): Composition {
  const input = record(value);
  const profile = assignedProfile ?? parseProfile(input.profile);
  const bpm = parseBpm(input.bpm);
  if (input.key !== profile.key || bpm !== profile.bpm) throw new BridgeError(400, 'INVALID_INPUT', 'Composition tempo/key must match its musical profile.');
  return { profile, bpm, key: profile.key, loops: parseLoops(input.loops, 'codex', true, bpm, profile), source: 'codex' };
}

const numeric = (minimum: number, maximum: number, integer = false) => ({ type: integer ? 'integer' : 'number', minimum, maximum });

export const loopSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'role', 'events', 'gain', 'pan', 'cutoff'],
  properties: {
    id: numeric(0, 7, true), role: { type: 'string', enum: [...ROLES] },
    events: {
      type: 'array', minItems: 1, maxItems: 64,
      items: {
        type: 'object', additionalProperties: false,
        required: ['step', 'note', 'velocity', 'duration'],
        properties: { step: numeric(0, 31, true), note: numeric(24, 96, true), velocity: numeric(0.02, 1), duration: numeric(0.25, 32) },
      },
    },
    gain: numeric(0.02, 1), pan: numeric(-1, 1), cutoff: numeric(100, 18000),
  },
};

export const compositionSchema = (profile: MusicalProfile) => ({
  type: 'object', additionalProperties: false, required: ['bpm', 'key', 'loops'],
  properties: {
    bpm: { type: 'number', enum: [profile.bpm] }, key: { type: 'string', enum: [profile.key] },
    loops: { type: 'array', minItems: 8, maxItems: 8, items: loopSchema },
  },
});
