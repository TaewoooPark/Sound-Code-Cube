import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLES, type Composition, type GenreId, type Loop, type MusicalProfile } from '../shared/music.ts';
import { GENRE_IDS, PROFILES, SCALE_INTERVALS, selectProfile } from '../shared/profiles.ts';
import { BridgeError, compositionSchema, loopSchema, parseComposition, parseLoop } from './validation.ts';
import { codexEnvironment, runProcess } from './process.ts';

export type CodexReason = 'ready' | 'not-installed' | 'incompatible-cli' | 'not-authenticated' | 'api-key-login' | 'probe-timeout' | 'probe-failed';
export interface CodexRuntime {
  available: boolean;
  authenticated: boolean;
  ready: boolean;
  authMethod: 'chatgpt' | 'api-key' | 'none' | 'unknown';
  version: string | null;
  reason: CodexReason;
  action: string;
  binary: string | null;
}
export interface CodexStatus extends Omit<CodexRuntime, 'binary'> { busy: boolean; }
const requiredExecFlags = ['--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', '--config', '--color', '--json', '--output-schema', '--output-last-message', '--cd'];
const runtimeActions: Record<CodexReason, string> = {
  ready: 'Ready. Composition uses this computer\'s own Codex ChatGPT sign-in.',
  'not-installed': 'Install the current Codex CLI with npm install -g @openai/codex, then run npm run login.',
  'incompatible-cli': 'Update Codex with npm install -g @openai/codex@latest. This app needs exec, isolated configuration, ephemeral sessions, and structured JSON output.',
  'not-authenticated': 'Run npm run login on this computer and sign in with your own ChatGPT account, then press Play again.',
  'api-key-login': 'Codex is signed in with an API key. Run npm run login and choose your own ChatGPT account; this app requires ChatGPT OAuth.',
  'probe-timeout': 'Codex did not answer in time. Run npm run doctor and codex login status in your terminal, then retry.',
  'probe-failed': 'Codex could not be checked. Run npm run doctor and check CODEX_BIN, executable permissions, and your local Codex installation.',
};

/** Read-only CLI probes. Never reads, copies, logs, or returns credential files or raw login output. */
export async function detectCodexRuntime(options: { command?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CodexRuntime> {
  const explicit = options.command ?? process.env.CODEX_BIN;
  const commands = explicit ? [explicit] : ['codex', ...(process.platform === 'darwin' ? [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
    join(homedir(), 'Applications/Codex.app/Contents/Resources/codex'),
  ] : [])];
  let runtime: CodexRuntime = { available: false, authenticated: false, ready: false, authMethod: 'none', version: null, reason: 'not-installed', action: runtimeActions['not-installed'], binary: null };
  const finish = (reason: CodexReason): CodexRuntime => ({ ...runtime, reason, action: runtimeActions[reason], ready: reason === 'ready' });
  const probe = (command: string, args: string[]) => runProcess(command, args, { timeoutMs: options.timeoutMs ?? 8000, maxBytes: 65536, env: codexEnvironment(), signal: options.signal });
  for (const command of commands) {
    try {
      const version = await probe(command, ['--version']);
      runtime = { ...runtime, binary: command };
      if (version.code !== 0) return finish('probe-failed');
      const match = (version.stdout + version.stderr).match(/\bcodex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i);
      if (!match) return finish('incompatible-cli');
      runtime = { ...runtime, available: true, version: match[1] };
      const help = await probe(command, ['exec', '--help']);
      const supported = help.stdout + help.stderr;
      if (help.code !== 0 || requiredExecFlags.some(flag => !supported.includes(flag))) return finish('incompatible-cli');
      const login = await probe(command, ['login', 'status']);
      const loginText = login.stdout + login.stderr;
      if (login.code === 0 && /Logged in using ChatGPT\b/i.test(loginText)) {
        runtime = { ...runtime, authenticated: true, authMethod: 'chatgpt' };
        return finish('ready');
      }
      if (/API[ -]?key/i.test(loginText)) {
        runtime = { ...runtime, authMethod: 'api-key' };
        return finish('api-key-login');
      }
      if (/not logged in|not authenticated|no.*credentials/i.test(loginText)) return finish('not-authenticated');
      runtime = { ...runtime, authMethod: 'unknown' };
      return finish('probe-failed');
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'CANCELLED') throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      runtime = { ...runtime, binary: command };
      return finish(error instanceof BridgeError && error.code === 'CODEX_TIMEOUT' ? 'probe-timeout' : 'probe-failed');
    }
  }
  return finish('not-installed');
}

const musicalDirections = (profile: MusicalProfile) => `You are the composer for a live-coding sound sculpture.
Return only the JSON matching the supplied schema. Do not use tools, inspect files, run commands, browse, or write code.
You receive symbolic note, rhythm and mix data, not an audio recording. Do not claim to hear the music.
Genre: ${profile.label}. Tempo: ${profile.bpm} BPM. Key: ${profile.key}. Bass tonic MIDI ${profile.root}.
Genre-specific direction: ${PROFILES.find(item => item.id === profile.id)!.direction}
Make this unmistakably ${profile.label}, including its characteristic drum placement, bass articulation and harmonic rhythm.
Do not default to a generic four-on-the-floor beat; it is appropriate only for deep-house and techno.
Allowed pitched-note pitch classes: ${SCALE_INTERVALS[profile.scale].map(interval => (profile.root + interval) % 12).join(', ')}. Use tonic-centered phrases and octave motion.
Assigned real instruments/samples, one per role: ${JSON.stringify(profile.sounds)}.
These timbres are already loaded. Compose specifically for them. Do not include instrument, sound or profile fields in your response.
Each loop is exactly 32 sixteenth-note steps = 2 bars = 2 TidalCycles cycles in 4/4.
Steps are integers 0..31; duration is measured in sixteenth-note steps. MIDI notes are integers.
Layers enter one at a time at cycles 0,2,4,6,8,10,12,14; all eight then loop indefinitely.
Compose each later layer in response to the preceding layers. Keep the sum spacious and avoid clashing low frequencies.
Use ids and roles exactly: ${ROLES.map((role, id) => `${id}=${role}`).join(', ')}.
Kick note36, snare note38, hats note42, percussion note45; pitched parts use the supplied scale.
Kick gain .65-.8; bass .3-.5; all other gains .12-.4. Pan -1..1. Cutoff 100..18000 Hz.
Bass must leave space around kicks. Adapt the backbeat, syncopation and silence to the chosen genre.
Use a recurring bass motif, genre-specific chords, a memorable motif, and spacious texture.
For ambient use 1-4 percussion events and long 12-24 step tones; for drum-and-bass use rolling 20-32 hats and ghost notes;
for dub use one-drop drums and offbeat skanks; for UK garage use two-step broken kicks; for trip-hop use slow broken drums;
for electro use syncopated 808 machine funk; for techno use driving kicks and 8-16 short acid notes; for deep-house use warm stabs and offbeat hats.
Other parts usually need 3-12 events; use at most 12 simultaneous chord notes total. Do not duplicate a step/note pair.
Use sensible numeric precision (at most 3 decimal places). No descriptions, source fields, Haskell, or markdown.`;

export class CodexComposer {
  private busy = false;
  private cachedStatus?: { at: number; runtime: CodexRuntime };
  private statusPromise?: Promise<CodexRuntime>;
  private lastGenre?: GenreId;

  constructor(private readonly options: { command?: string; timeoutMs?: number } = {}) {}

  async status(fresh = false, signal?: AbortSignal): Promise<CodexStatus> {
    if (signal?.aborted) throw new BridgeError(499, 'CANCELLED', 'Codex check cancelled.');
    let runtime = !fresh && this.cachedStatus && Date.now() - this.cachedStatus.at < 15000 ? this.cachedStatus.runtime : undefined;
    if (!runtime) {
      const check = () => detectCodexRuntime({ ...this.options, signal }).then(result => {
        this.cachedStatus = { at: Date.now(), runtime: result };
        return result;
      });
      // A request-scoped probe owns its process. Cancelling it cannot kill another tab's check.
      if (signal) runtime = await check();
      else {
        this.statusPromise ??= check().finally(() => { this.statusPromise = undefined; });
        runtime = await this.statusPromise;
      }
    }
    const { binary: _binary, ...status } = runtime;
    return { ...status, busy: this.busy };
  }

  async compose(seed: number, genre: GenreId | 'auto' = 'auto', signal?: AbortSignal, previous?: Composition): Promise<Composition> {
    let profile = selectProfile(seed, genre);
    if (genre === 'auto' && profile.id === this.lastGenre) {
      const nextGenre = GENRE_IDS[(GENRE_IDS.indexOf(profile.id) + 1 + seed % (GENRE_IDS.length - 1)) % GENRE_IDS.length];
      profile = selectProfile(seed, nextGenre);
    }
    const transitionContext = previous ? `\nThis new genre will overlap the following current score during an eight-second crossfade. Preserve a recognizable rhythmic or melodic gesture, prefer compatible initial chord tones where the keys overlap, and leave space in the first phrase while the old bass fades. Keep the requested new genre and tempo distinct. This is symbolic context, not heard audio:\n${JSON.stringify({ profile: previous.profile, loops: previous.loops.map(loop => ({ role: loop.role, sound: loop.sound, gain: loop.gain, events: loop.events.slice(0, 12) })) })}` : '';
    const result = await this.generate(compositionSchema(profile), `${musicalDirections(profile)}${transitionContext}\nVariation seed: ${seed}.\nReturn a complete score with bpm ${profile.bpm}, key ${JSON.stringify(profile.key)}, and all eight layers in id order.`, signal);
    try { const composition = parseComposition(result, profile); this.lastGenre = profile.id; return composition; }
    catch { throw new BridgeError(502, 'INVALID_COMPOSITION', 'Codex returned an invalid musical score.'); }
  }

  async next(loops: Loop[], id: number, seed: number, profile: MusicalProfile, signal?: AbortSignal): Promise<Loop> {
    const context = loops.map(({ tidal: _tidal, source: _source, ...loop }) => loop);
    const result = await this.generate(loopSchema, `${musicalDirections(profile)}\nVariation seed: ${seed}.\nThe current buffered score follows:\n${JSON.stringify(context)}\nReconsider only the upcoming layer id ${id}, role ${ROLES[id]}. Respond with that one loop. Preserve the existing genre, tempo, instruments, groove, tonal center and density. Earlier layers are already playing.`, signal);
    try { return parseLoop(result, 'codex', id, profile.bpm, profile.sounds[ROLES[id]]); }
    catch { throw new BridgeError(502, 'INVALID_COMPOSITION', 'Codex returned an invalid musical layer.'); }
  }

  private async generate(schema: object, prompt: string, signal?: AbortSignal): Promise<unknown> {
    if (this.busy) throw new BridgeError(429, 'CODEX_BUSY', 'Another composition is in progress.');
    // Reserve before checking login so two simultaneous callers cannot both pass the guard.
    this.busy = true;
    let directory: string | undefined;
    try {
      const runtime = await detectCodexRuntime({ ...this.options, signal });
      this.cachedStatus = { at: Date.now(), runtime };
      if (!runtime.ready) throw new BridgeError(503, 'CODEX_UNAVAILABLE', runtime.action);
      if (signal?.aborted) throw new BridgeError(499, 'CANCELLED', 'Generation cancelled.');
      directory = await mkdtemp(join(tmpdir(), 'sound-code-cube-'));
      const schemaPath = join(directory, 'score.schema.json');
      const outputPath = join(directory, 'score.json');
      await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
      const args = [
        'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--config', 'approval_policy="never"',
        '--config', 'model_reasoning_effort="low"',
        '--color', 'never', '--json', '--output-schema', schemaPath,
        '--output-last-message', outputPath, '--cd', directory,
      ];
      if (process.env.CODEX_MODEL) args.push('--model', process.env.CODEX_MODEL);
      args.push('-');
      const timeoutMs = Math.min(240000, Math.max(10000, Number(process.env.CODEX_TIMEOUT_MS) || 120000));
      const result = await runProcess(runtime.binary!, args, { cwd: directory, input: prompt, timeoutMs, maxBytes: 2 * 1024 * 1024, signal, env: codexEnvironment() });
      if (result.code !== 0) {
        this.cachedStatus = undefined;
        throw new BridgeError(502, 'CODEX_FAILED', `Codex generation exited with code ${result.code}.`);
      }
      const file = await stat(outputPath).catch(() => null);
      if (!file || file.size > 128 * 1024) throw new BridgeError(502, 'INVALID_COMPOSITION', 'Codex did not produce a bounded score.');
      try { return JSON.parse(await readFile(outputPath, 'utf8')); }
      catch { throw new BridgeError(502, 'INVALID_COMPOSITION', 'Codex did not produce valid JSON.'); }
    } finally {
      this.busy = false;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
