import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameDistance, selectFrames } from '../../src/lib/videoFrames.ts';
import type { FrameFeature } from '../../src/lib/videoFrames.ts';
const frame = (time: number, value: number, variance = 100): FrameFeature => ({ time, pixels: Array(144).fill(value), histogram: Array.from({ length: 16 }, (_, i) => i === Math.floor(value / 16) ? 1 : 0), variance });
test('selection is bounded, chronological and covers a distant scene change', () => {
  const frames = Array.from({ length: 90 }, (_, i) => frame(i * 2, i < 45 ? 32 : 220));
  const selected = selectFrames(frames);
  assert.ok(selected.length <= 8);
  assert.ok(selected.some(item => item.time < 90));
  assert.ok(selected.some(item => item.time >= 90));
  assert.deepEqual(selected.map(item => item.time), selected.map(item => item.time).sort((a, b) => a - b));
});
test('near duplicates are reduced and blank frames excluded when detail is available', () => {
  const a = frame(0, 0, 0); const b = frame(1, 100); const c = frame(1.1, 100);
  assert.equal(frameDistance(b, c), 0);
  const result = selectFrames([a, b, c, frame(10, 200)]);
  assert.ok(!result.includes(a)); assert.ok(!(result.includes(b) && result.includes(c)));
});
test('empty input and blank-only input remain bounded', () => {
  assert.deepEqual(selectFrames([]), []);
  assert.equal(selectFrames([frame(0, 0, 0)]).length, 1);
  assert.deepEqual(selectFrames([frame(0, 2)], 0), []);
});
