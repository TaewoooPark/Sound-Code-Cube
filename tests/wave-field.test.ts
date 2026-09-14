import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveField } from '../src/visual/wave-field.ts';
import { PALETTES, paletteGradient, sampleColorMap } from '../src/visual/colormap.ts';

test('a local disturbance propagates causally through neighbours', () => {
  const wave = new WaveField({ size: 11, length: 1, speed: 1, timeStep: 0.025, damping: 0 });
  const center = wave.index(5, 5, 5);
  wave.current[center] = 1;
  wave.previous[center] = 1;
  wave.step();
  assert.ok(wave.current[wave.index(6, 5, 5)] > 0);
  assert.equal(wave.current[wave.index(7, 5, 5)], 0);
  assert.equal(wave.current[wave.index(0, 0, 0)], 0);
  wave.step();
  assert.ok(wave.current[wave.index(7, 5, 5)] > 0);
});

test('independent sources superpose, including destructive interference', () => {
  const options = { size: 13, length: 2, timeStep: 0.025, damping: 0.2 };
  const a = new WaveField(options), b = new WaveField(options), combined = new WaveField(options);
  a.forceCorner(0, 100);
  b.forceCorner(7, -80);
  combined.forceCorner(0, 100);
  combined.forceCorner(7, -80);
  a.step(50); b.step(50); combined.step(50);
  for (let i = 0; i < combined.current.length; i++) {
    assert.ok(Math.abs(combined.current[i] - a.current[i] - b.current[i]) < 0.000001);
  }
  const cancel = new WaveField(options);
  cancel.forceCorner(3, 100);
  cancel.forceCorner(3, -100);
  cancel.step(20);
  assert.ok(cancel.peak() < 1e-12, 'Opposing sources should cancel within floating-point tolerance.');
});

test('rigid Neumann walls preserve a constant pressure field', () => {
  const wave = new WaveField({ size: 9, damping: 0 });
  wave.current.fill(0.25);
  wave.previous.fill(0.25);
  wave.step(100);
  for (const value of wave.current) assert.equal(value, 0.25);
});

test('an incoming planar pulse reflects from a rigid wall without phase inversion', () => {
  const wave = new WaveField({ size: 41, length: 4, speed: 1, timeStep: 0.025, damping: 0 });
  const sigma = 0.16;
  for (let z = 0; z < wave.size; z++) for (let y = 0; y < wave.size; y++) for (let x = 0; x < wave.size; x++) {
    const position = x * wave.spacing;
    const i = wave.index(x, y, z);
    wave.current[i] = Math.exp(-0.5 * ((position - 0.6) / sigma) ** 2);
    wave.previous[i] = Math.exp(-0.5 * ((position - 0.625) / sigma) ** 2);
  }
  wave.step(44);
  const reflectedPeak = wave.current[wave.index(4, 20, 20)];
  assert.ok(reflectedPeak > 0.65, `Expected a positive reflected pulse, got ${reflectedPeak}`);
  assert.ok(Math.abs(wave.current[wave.index(22, 20, 20)]) < 0.05);
});

test('stable time steps remain bounded and invalid CFL parameters are rejected', () => {
  assert.throws(() => new WaveField({ size: 33, timeStep: 1 }), /CFL/);
  assert.throws(() => new WaveField({ size: 2 }), /three cells/);
  const wave = new WaveField({ size: 17, length: 2, speed: 1, timeStep: 0.06, damping: 0.3 });
  wave.forceCorner(0, 20);
  const start = wave.peak();
  wave.step(1200);
  assert.ok(Number.isFinite(wave.peak()));
  assert.ok(wave.peak() < start, `Damped pressure should remain bounded: ${wave.peak()} < ${start}`);
});

test('all selectable palettes produce finite RGB colors and clamp amplitude lookup', () => {
  assert.equal(PALETTES.length, 5);
  for (const palette of PALETTES) {
    for (const amplitude of [-2, 0, 0.1, 0.5, 0.9, 1, 4, Number.NaN]) {
      const rgb = sampleColorMap(palette.id, amplitude);
      assert.equal(rgb.length, 3);
      assert.ok(rgb.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1));
    }
    assert.deepEqual(sampleColorMap(palette.id, -1), sampleColorMap(palette.id, 0));
    assert.deepEqual(sampleColorMap(palette.id, 2), sampleColorMap(palette.id, 1));
    assert.notDeepEqual(sampleColorMap(palette.id, 0), sampleColorMap(palette.id, 1));
    assert.match(paletteGradient(palette.id, 0.2, 0.8), /^linear-gradient\(90deg,/);
  }
});
