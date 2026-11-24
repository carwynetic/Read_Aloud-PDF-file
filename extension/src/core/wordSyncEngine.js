/**
 * Synchronizes audio playback timestamps (ms) with both:
 * 1. Exact Vietnamese word index (from backend energy-envelope wordTimings)
 * 2. Proportional English source word index on the PDF canvas
 */

export function getSyncStateAtTime(currentTimeMs, durationMs, wordTimings = [], sourceWords = []) {
  const safeDuration = Math.max(1, Number(durationMs) || 1);
  const clampedMs = Math.max(0, Number(currentTimeMs) || 0);

  let viWordIndex = 0;
  let progress = Math.min(1, clampedMs / safeDuration);

  if (Array.isArray(wordTimings) && wordTimings.length > 0) {
    const firstStart = wordTimings[0].startMs ?? 0;
    const lastEnd = wordTimings[wordTimings.length - 1].endMs ?? safeDuration;
    const speechSpan = Math.max(1, lastEnd - firstStart);

    if (clampedMs <= firstStart) {
      viWordIndex = 0;
      progress = 0;
    } else if (clampedMs >= lastEnd) {
      viWordIndex = wordTimings.length - 1;
      progress = 1;
    } else {
      progress = Math.max(0, Math.min(1, (clampedMs - firstStart) / speechSpan));
      for (let i = 0; i < wordTimings.length; i++) {
        const item = wordTimings[i];
        if (clampedMs >= item.startMs && clampedMs < item.endMs) {
          viWordIndex = i;
          break;
        }
        if (clampedMs >= item.startMs) {
          viWordIndex = i;
        }
      }
    }
  }

  let enWordIndex = 0;
  if (Array.isArray(sourceWords) && sourceWords.length > 0) {
    if (progress >= 1) {
      enWordIndex = sourceWords.length - 1;
    } else {
      // Character-weighted progression across English source words for natural pacing
      const weights = sourceWords.map((w) => Math.max(2, (w.word || '').length + 1));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const targetWeight = progress * totalWeight;
      let acc = 0;
      enWordIndex = sourceWords.length - 1;
      for (let i = 0; i < weights.length; i++) {
        acc += weights[i];
        if (targetWeight <= acc) {
          enWordIndex = i;
          break;
        }
      }
    }
  }

  return {
    viWordIndex,
    enWordIndex,
    progress,
    activeSourceWord: sourceWords[enWordIndex] || null,
    activeViWord: wordTimings[viWordIndex] || null,
  };
}
