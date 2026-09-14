import test from 'node:test';
import assert from 'node:assert/strict';
import { BPM, ROLES, type Loop } from '../shared/music';
import { createLocalComposition, loopToTidal } from '../shared/patterns';
import { GENRE_IDS, isSupportedSound, PROFILES, SCALE_INTERVALS, selectProfile } from '../shared/profiles';
import { AudioEngine } from '../src/audio/AudioEngine';

const expand = (notation: string) => notation.split(' ').flatMap(token => {
  const [value, repeat] = token.split('!');
  return Array(Number(repeat ?? 1)).fill(value) as string[];
});

test('local score has eight valid, explicitly local, deterministic two-cycle loops', () => {
  const score = createLocalComposition(42);
  assert.deepEqual(score, createLocalComposition(42));
  assert.equal(score.source, 'local');
  assert.equal(score.bpm, score.profile.bpm);
  assert.equal(score.key, score.profile.key);
  assert.deepEqual(score.loops.map(loop => loop.role), ROLES);
  for (const loop of score.loops) {
    assert.equal(loop.source, 'local');
    assert.match(loop.tidal, new RegExp(`^d${loop.id + 1} \\$ slow 2 \\$ `));
    for (const event of loop.events) {
      assert.ok(Number.isInteger(event.step) && event.step >= 0 && event.step < 32);
      assert.ok(event.velocity > 0 && event.velocity <= 1);
      assert.ok(event.note >= 24 && event.note <= 96);
      assert.ok(event.duration >= 0.25 && event.duration <= 32);
    }
  }
});

test('Tidal preserves independent simultaneous notes and absolute sustain duration', () => {
  const fixture: Omit<Loop, 'tidal'> = {
    id: 5, role: 'chords', sound: 'sccchords', gain: 0.5, pan: -0.5, cutoff: 4200, source: 'codex',
    events: [
      { step: 0, note: 62, velocity: 0.8, duration: 4 },
      { step: 0, note: 65, velocity: 0.4, duration: 8 },
      { step: 16, note: 69, velocity: 0.6, duration: 2 },
    ],
  };
  const code = loopToTidal(fixture);
  assert.match(code, /^d6 \$ slow 2 \$ stack \[/);
  assert.match(code, /# pan 0\.25 # cutoff 4200$/);
  const lanes = [...code.matchAll(/midinote "([^"]+)" # s "sccchords" # gain "([^"]+)" # sustain "([^"]+)"/g)];
  assert.equal(lanes.length, 2);
  const reconstructed: { step: number; note: number; gain: number; seconds: number }[] = [];
  for (const [, notes, gains, durations] of lanes) {
    const noteSteps = expand(notes), gainSteps = expand(gains), durationSteps = expand(durations);
    assert.equal(noteSteps.length, 32);
    assert.equal(gainSteps.length, 32);
    assert.equal(durationSteps.length, 32);
    noteSteps.forEach((note, step) => {
      if (note !== '~') reconstructed.push({ step, note: Number(note), gain: Number(gainSteps[step]), seconds: Number(durationSteps[step]) });
    });
  }
  for (const event of fixture.events) {
    const actual = reconstructed.find(candidate => candidate.step === event.step && candidate.note === event.note)!;
    assert.ok(actual);
    assert.ok(Math.abs(actual.gain ** 4 - event.velocity * fixture.gain) < 2e-6);
    assert.ok(Math.abs(actual.seconds - event.duration * 60 / BPM / 4) < 1e-6);
  }
});

test('drum pattern retains every onset over exactly 32 steps', () => {
  const loop = createLocalComposition(123).loops[0];
  const match = loop.tidal.match(/s "([^"]+)"/)!;
  const steps = expand(match[1]);
  assert.equal(steps.length, 32);
  assert.deepEqual(steps.flatMap((value, step) => value === '~' ? [] : [step]), loop.events.map(event => event.step));
  assert.ok(steps.every(value => value === '~' || value === loop.sound));
});

test('eight profiles create distinct grooves, tempi and actual instrument selections', () => {
  const scores = GENRE_IDS.map(genre => createLocalComposition(121, selectProfile(121, genre)));
  const rhythms = scores.map(score => JSON.stringify(score.loops.map(loop => loop.events.map(event => event.step))));
  const assets = scores.map(score => score.loops.map(loop => loop.sound).join(','));
  assert.equal(new Set(rhythms).size, 8);
  assert.equal(new Set(assets).size, 8);
  assert.ok(new Set(scores.map(score => score.bpm)).size >= 6);
  for (const score of scores) {
    const definition = PROFILES.find(profile => profile.id === score.profile.id)!;
    assert.ok(score.bpm >= definition.bpmRange[0] && score.bpm <= definition.bpmRange[1]);
    for (const loop of score.loops) {
      assert.ok(isSupportedSound(loop.sound, loop.role));
      assert.equal(loop.sound, score.profile.sounds[loop.role]);
      assert.ok(loop.events.length >= 1 && loop.events.length <= 64);
      if (['bass', 'chords', 'melody', 'texture'].includes(loop.role)) {
        for (const event of loop.events) {
          const degree = ((event.note - score.profile.root) % 12 + 12) % 12;
          assert.ok(SCALE_INTERVALS[score.profile.scale].includes(degree));
        }
      }
    }
  }
});

test('seed selection reaches all genres and multiple keys rather than one transposed fixed score', () => {
  const profiles = Array.from({ length: 128 }, (_, seed) => selectProfile(seed));
  assert.equal(new Set(profiles.map(profile => profile.id)).size, 8);
  assert.ok(new Set(profiles.map(profile => profile.key)).size >= 16);
  assert.ok(profiles.some(profile => profile.scale === 'major'));
  const houseScores = [10, 11, 12, 13].map(seed => createLocalComposition(seed, selectProfile(seed, 'deep-house')));
  assert.ok(new Set(houseScores.map(score => JSON.stringify(score.loops[6].events.map(event => event.step)))).size > 1);
});

test('Tidal sustain and browser step duration follow the selected tempo', () => {
  const fixture = createLocalComposition(1, selectProfile(1, 'trip-hop')).loops[1];
  const sustain = (bpm: number) => expand(loopToTidal(fixture, bpm).match(/# sustain "([^"]+)"/)![1]).map(Number);
  const slow = sustain(84), fast = sustain(168);
  slow.forEach((value, index) => assert.ok(Math.abs(value - fast[index] * 2) < 2e-6));
  const engine = new AudioEngine({ onLoop: () => {}, onPulse: () => {} });
  for (const bpm of [72, 120, 170]) {
    engine.setBpm(bpm);
    assert.equal(engine.bpm, bpm);
    assert.ok(Math.abs(engine.stepSeconds * 32 - 480 / bpm) < 1e-12);
  }
  assert.throws(() => engine.setBpm(181));
});

test('sound selection accepts only known banks, existing indices and instrument roles', () => {
  assert.ok(isSupportedSound('808bd:24', 'kick'));
  assert.ok(isSupportedSound('sccacid', 'bass'));
  for (const sound of ['808bd:25', 'sd:-1', '../secret:0', 'bd:0" # gain 9', 'nonexistent:0']) {
    assert.equal(isSupportedSound(sound), false);
  }
  assert.equal(isSupportedSound('sccacid', 'kick'), false);
  assert.equal(isSupportedSound('bd:0', 'melody'), false);
});
