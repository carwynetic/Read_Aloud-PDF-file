import { describe, it, expect } from 'vitest';
import { getSyncStateAtTime } from '../core/wordSyncEngine.js';

describe('wordSyncEngine', () => {
  const wordTimings = [
    { index: 0, word: 'Xin', startMs: 100, endMs: 300 },
    { index: 1, word: 'chào', startMs: 300, endMs: 600 },
    { index: 2, word: 'thế', startMs: 600, endMs: 900 },
    { index: 3, word: 'giới.', startMs: 900, endMs: 1300 },
  ];
  const sourceWords = [
    { word: 'Hello', x: 0.1, y: 0.2, width: 0.08, height: 0.02 },
    { word: 'beautiful', x: 0.19, y: 0.2, width: 0.12, height: 0.02 },
    { word: 'world.', x: 0.32, y: 0.2, width: 0.09, height: 0.02 },
  ];

  it('returns active Vietnamese word index and mapped source PDF word index at timestamp', () => {
    const early = getSyncStateAtTime(150, 1400, wordTimings, sourceWords);
    expect(early.viWordIndex).toBe(0);
    expect(early.enWordIndex).toBe(0);
    expect(early.progress).toBeGreaterThan(0);
    expect(early.progress).toBeLessThan(0.35);

    const mid = getSyncStateAtTime(650, 1400, wordTimings, sourceWords);
    expect(mid.viWordIndex).toBe(2);
    expect(mid.enWordIndex).toBe(1);

    const late = getSyncStateAtTime(1200, 1400, wordTimings, sourceWords);
    expect(late.viWordIndex).toBe(3);
    expect(late.enWordIndex).toBe(2);
  });

  it('clamps cleanly before speech starts and after speech ends', () => {
    const before = getSyncStateAtTime(0, 1400, wordTimings, sourceWords);
    expect(before.viWordIndex).toBe(0);
    expect(before.enWordIndex).toBe(0);

    const after = getSyncStateAtTime(2000, 1400, wordTimings, sourceWords);
    expect(after.viWordIndex).toBe(3);
    expect(after.enWordIndex).toBe(2);
    expect(after.progress).toBe(1);
  });
});
