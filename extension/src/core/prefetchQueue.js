/**
 * Lookahead Prefetch Queue for zero-gap sentence-to-sentence narration.
 * Deduplicates concurrent requests, caches resolved payloads, and supports
 * clean cancellation on seek, voice switch, or stop.
 */

export class PrefetchQueue {
  constructor({ fetcher, lookahead = 2, maxCacheSize = 40 } = {}) {
    if (typeof fetcher !== 'function') {
      throw new Error('PrefetchQueue requires a fetcher function');
    }
    this.fetcher = fetcher;
    this.lookahead = Math.max(0, lookahead);
    this.maxCacheSize = Math.max(5, maxCacheSize);
    this._cache = new Map();
    this._inflight = new Map();
    this._controllers = new Set();
    this._generation = 0;
  }

  _fetchOne(sentence, generation) {
    const key = sentence.id;
    if (this._cache.has(key)) {
      return Promise.resolve(this._cache.get(key));
    }
    if (this._inflight.has(key)) {
      return this._inflight.get(key);
    }

    const controller = new AbortController();
    this._controllers.add(controller);

    let rawPromise;
    try {
      rawPromise = Promise.resolve(this.fetcher(sentence, controller.signal));
    } catch (err) {
      rawPromise = Promise.reject(err);
    }

    const promise = rawPromise
      .then((result) => {
        if (generation === this._generation) {
          this._cache.set(key, result);
          if (this._cache.size > this.maxCacheSize) {
            const oldestKey = this._cache.keys().next().value;
            this._cache.delete(oldestKey);
          }
        }
        return result;
      })
      .finally(() => {
        this._controllers.delete(controller);
        if (this._inflight.get(key) === promise) {
          this._inflight.delete(key);
        }
      });

    this._inflight.set(key, promise);
    return promise;
  }

  has(sentenceId) {
    return this._cache.has(sentenceId);
  }

  warm(sentences, index) {
    if (!Array.isArray(sentences) || index < 0 || index >= sentences.length) return;
    const gen = this._generation;
    const target = sentences[index];
    if (target && !this._cache.has(target.id) && !this._inflight.has(target.id)) {
      this._fetchOne(target, gen).catch(() => {});
    }
  }

  async get(sentences, index) {
    if (!Array.isArray(sentences) || index < 0 || index >= sentences.length) {
      throw new RangeError(`Sentence index ${index} out of bounds`);
    }
    const gen = this._generation;
    const current = sentences[index];
    const result = await this._fetchOne(current, gen);

    // Kick off non-blocking lookahead prefetch for upcoming sentences
    if (gen === this._generation) {
      for (let offset = 1; offset <= this.lookahead; offset++) {
        const nextSentence = sentences[index + offset];
        if (nextSentence) {
          this._fetchOne(nextSentence, gen).catch(() => {});
        }
      }
    }

    return result;
  }

  invalidate() {
    this._generation += 1;
    for (const controller of this._controllers) {
      try {
        controller.abort();
      } catch {
        // ignore abort errors
      }
    }
    this._controllers.clear();
    this._inflight.clear();
    this._cache.clear();
  }
}
