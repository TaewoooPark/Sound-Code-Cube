import test from 'node:test';
import assert from 'node:assert/strict';
import { CubeGesture, hitTestProjectedCorner, type GesturePoint } from '../src/visual/gestures.ts';

function recognize(points: GesturePoint[]) {
  const gesture = new CubeGesture();
  gesture.begin(points[0]);
  for (const point of points.slice(1, -1)) gesture.move(point);
  return gesture.end(points[points.length - 1]);
}

const zigzag: GesturePoint[] = [
  { x: 0, y: 0, time: 0 }, { x: 70, y: 3, time: 70 }, { x: 140, y: 6, time: 140 },
  { x: 70, y: 2, time: 210 }, { x: -30, y: -4, time: 280 },
  { x: 40, y: 0, time: 330 }, { x: 140, y: 6, time: 370 }, { x: 210, y: 10, time: 400 },
];

test('three rapid taps remain three independent tap results', () => {
  const gesture = new CubeGesture();
  let taps = 0;
  for (let i = 0; i < 3; i++) {
    gesture.begin({ x: 100, y: 100, time: i * 70 });
    const result = gesture.end({ x: 102, y: 99, time: i * 70 + 30 });
    if (result.kind === 'tap') taps++;
  }
  assert.equal(taps, 3);
});

test('moving away and returning to a corner does not count as a click', () => {
  const result = recognize([{ x: 0, y: 0, time: 0 }, { x: 30, y: 0, time: 90 }, { x: 0, y: 0, time: 180 }]);
  assert.equal(result.kind, 'drag');
});

test('two substantial reversals followed by a fast release count as one throw', () => {
  const result = recognize(zigzag);
  assert.equal(result.kind, 'throw');
  assert.equal(result.reversals, 2);
  assert.ok(result.vx > 1);
});

test('a single fast flick is just an ordinary rotation', () => {
  const result = recognize([{ x: 0, y: 0, time: 0 }, { x: 220, y: 0, time: 70 }, { x: 330, y: 0, time: 100 }]);
  assert.equal(result.kind, 'drag');
});

test('a smooth circular rotation does not trigger genre change', () => {
  const circle = Array.from({ length: 45 }, (_, i) => ({ x: 150 * Math.cos(i / 44 * Math.PI * 2), y: 150 * Math.sin(i / 44 * Math.PI * 2), time: i * 12 }));
  const result = recognize(circle);
  assert.equal(result.kind, 'drag');
  assert.equal(result.reversals, 0);
});

test('slow zigzags and a fast zigzag held still before release do not throw', () => {
  assert.equal(recognize(zigzag.map(point => ({ ...point, time: point.time * 6 }))).kind, 'drag');
  assert.equal(recognize([...zigzag, { ...zigzag.at(-1)!, time: 650 }]).kind, 'drag');
});

test('small back-and-forth jitter does not become a deliberate throw', () => {
  const points = Array.from({ length: 50 }, (_, i) => ({ x: i % 2 ? 8 : 0, y: 0, time: i * 7 }));
  assert.notEqual(recognize(points).kind, 'throw');
});

test('cancelled touch or multi-pointer gestures cannot later produce a tap', () => {
  const gesture = new CubeGesture();
  gesture.begin({ x: 10, y: 10, time: 0 });
  gesture.cancel();
  assert.equal(gesture.active, false);
  assert.equal(gesture.end({ x: 10, y: 10, time: 40 }).kind, 'drag');
});

test('corner picking allows a generous target and chooses the nearest depth on overlap', () => {
  const corners = [{ id: 0, x: 50, y: 50, depth: 0.7 }, { id: 1, x: 50, y: 50, depth: 0.2 }, { id: 2, x: 100, y: 50, depth: 0.2 }];
  assert.equal(hitTestProjectedCorner(corners, 50, 70), 1);
  assert.equal(hitTestProjectedCorner(corners, 100, 68), 2);
  assert.equal(hitTestProjectedCorner(corners, 50, 74), null);
});
