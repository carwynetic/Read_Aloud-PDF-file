import { describe, it, expect } from 'vitest';
import { PrefetchQueue } from '../core/prefetchQueue.js';

describe('PrefetchQueue', () => {
  it('fetches requested sentence and automatically prefetches upcoming sentences', async () => {
    const fetched = [];
    const fetcher = async (sentence) => {
      fetched.push(sentence.id);
      return { translatedText: `VI:${sentence.text}`, audioBase64: 'AAA', durationMs: 500, wordTimings: [] };
    };

    const sentences = [
      { id: 's0', text: 'First.' },
      { id: 's1', text: 'Second.' },
      { id: 's2', text: 'Third.' },
      { id: 's3', text: 'Fourth.' },
    ];

    const queue = new PrefetchQueue({ fetcher, lookahead: 2 });
    const first = await queue.get(sentences, 0);
    expect(first.translatedText).toBe('VI:First.');

    // Wait a tick for lookahead prefetches to resolve
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched).toEqual(['s0', 's1', 's2']);

    // Second call should hit cache without re-fetching s1
    const second = await queue.get(sentences, 1);
    expect(second.translatedText).toBe('VI:Second.');
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('clears cache and aborts in-flight requests on invalidate', async () => {
    let aborted = false;
    const fetcher = (sentence, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('Aborted'));
        });
        setTimeout(() => resolve({ translatedText: sentence.text }), 100);
      });

    const queue = new PrefetchQueue({ fetcher, lookahead: 1 });
    const p = queue.get([{ id: 's0', text: 'Slow.' }], 0).catch(() => null);
    queue.invalidate();
    await p;
    expect(aborted).toBe(true);
  });
});
