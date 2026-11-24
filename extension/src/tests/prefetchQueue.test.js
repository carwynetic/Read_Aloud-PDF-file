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

  it('prefetches lookahead audio strictly in sequential order so i+1 is never blocked by i+3', async () => {
    const started = [];
    const finished = [];
    const delays = { s0: 5, s1: 35, s2: 5, s3: 5 };
    const fetcher = async (sentence) => {
      started.push(sentence.id);
      await new Promise((r) => setTimeout(r, delays[sentence.id] || 5));
      finished.push(sentence.id);
      return { translatedText: `VI:${sentence.text}`, audioBase64: 'AAA', durationMs: 500, wordTimings: [] };
    };

    const sentences = [
      { id: 's0', text: 'Zero.' },
      { id: 's1', text: 'One.' },
      { id: 's2', text: 'Two.' },
      { id: 's3', text: 'Three.' },
    ];

    const queue = new PrefetchQueue({ fetcher, lookahead: 3 });
    await queue.get(sentences, 0);
    await new Promise((r) => setTimeout(r, 120));

    expect(started).toEqual(['s0', 's1', 's2', 's3']);
    expect(finished).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('triggers parallel batch translation ahead of audio synthesis', async () => {
    const translatedBatches = [];
    const queue = new PrefetchQueue({
      fetcher: async (s) => ({ translatedText: `VI:${s.text}`, audioBase64: 'AAA', durationMs: 400, wordTimings: [] }),
      batchTranslator: async (chunk) => {
        translatedBatches.push(chunk.map((s) => s.id));
        return chunk.map((s) => ({ translatedText: `VI:${s.text}`, provider: 'groq' }));
      },
      lookahead: 1,
      translateBatchSize: 4,
    });

    const sentences = [
      { id: 's0', text: 'A.' },
      { id: 's1', text: 'B.' },
      { id: 's2', text: 'C.' },
      { id: 's3', text: 'D.' },
      { id: 's4', text: 'E.' },
    ];

    await queue.get(sentences, 0);
    await new Promise((r) => setTimeout(r, 25));

    expect(translatedBatches.length).toBeGreaterThanOrEqual(1);
    expect(translatedBatches[0]).toEqual(['s0', 's1', 's2', 's3']);
    expect(queue.getTranslation('s2')?.translatedText).toBe('VI:C.');
  });
});
