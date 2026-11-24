/**
 * Two-Stage Lookahead Prefetch Queue for Zero-Gap PDF Narration:
 *
 * Stage 1 (Parallel Multi-Threaded Translation):
 *   Translates upcoming sentences in parallel batches (e.g. 12 at once via
 *   backend ThreadPoolExecutor rotating across Groq/Gemini keys) so translation
 *   latency during playback drops to 0ms.
 *
 * Stage 2 (Strictly Ordered Sequential Audio Pre-Synthesis):
 *   Pre-synthesizes VieNeu-TTS audio strictly in order (i+1 -> i+2 -> i+3 -> i+4)
 *   so the very next sentence ALWAYS gets CPU priority and is never blocked by
 *   a farther-ahead sentence grabbing the synthesis lock first.
 */

export class PrefetchQueue {
  constructor({
    fetcher,
    batchTranslator = null,
    lookahead = 4,
    translateBatchSize = 12,
    maxCacheSize = 60,
    onBufferChange = null,
  } = {}) {
    if (typeof fetcher !== 'function') {
      throw new Error('PrefetchQueue requires a fetcher function');
    }
    this.fetcher = fetcher;
    this.batchTranslator = typeof batchTranslator === 'function' ? batchTranslator : null;
    this.lookahead = Math.max(0, lookahead);
    this.translateBatchSize = Math.max(1, translateBatchSize);
    this.maxCacheSize = Math.max(8, maxCacheSize);
    this.onBufferChange = typeof onBufferChange === 'function' ? onBufferChange : null;

    this._cache = new Map();
    this._inflight = new Map();
    this._translations = new Map();
    this._translatingIds = new Set();
    this._controllers = new Set();
    this._generation = 0;

    // Sequential audio prefetch state
    this._bgRunning = false;
    this._bgAnchorSentences = null;
    this._bgAnchorIndex = -1;
    this._bgTargetCount = 0;
  }

  has(sentenceId) {
    return this._cache.has(sentenceId);
  }

  getTranslation(sentenceId) {
    return this._translations.get(sentenceId) || null;
  }

  countBufferedAhead(sentences, index) {
    if (!Array.isArray(sentences) || index < 0) return 0;
    let count = 0;
    for (let offset = 1; offset <= this.lookahead; offset++) {
      const s = sentences[index + offset];
      if (!s) break;
      if (this._cache.has(s.id)) count += 1;
      else break;
    }
    return count;
  }

  _notifyBuffer() {
    if (this.onBufferChange) {
      try {
        this.onBufferChange();
      } catch {
        // ignore observer errors
      }
    }
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
          if (result?.translatedText && !this._translations.has(key)) {
            this._translations.set(key, {
              translatedText: result.translatedText,
              provider: result.provider || '',
            });
          }
          if (this._cache.size > this.maxCacheSize) {
            const oldestKey = this._cache.keys().next().value;
            this._cache.delete(oldestKey);
          }
          this._notifyBuffer();
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

  /**
   * Kick off a parallel multi-threaded batch translation for upcoming sentences.
   */
  warmTranslations(sentences, startIndex) {
    if (!this.batchTranslator || !Array.isArray(sentences) || startIndex < 0) return;

    const gen = this._generation;
    const end = Math.min(sentences.length, startIndex + this.translateBatchSize);
    const pending = [];

    for (let i = startIndex; i < end; i++) {
      const s = sentences[i];
      if (!s) continue;
      if (this._cache.has(s.id) || this._translations.has(s.id) || this._translatingIds.has(s.id)) {
        continue;
      }
      pending.push(s);
    }

    if (!pending.length) return;

    for (const s of pending) this._translatingIds.add(s.id);
    const controller = new AbortController();
    this._controllers.add(controller);

    Promise.resolve()
      .then(() => this.batchTranslator(pending, controller.signal))
      .then((items) => {
        if (gen !== this._generation || !Array.isArray(items)) return;
        for (let i = 0; i < pending.length; i++) {
          const item = items[i];
          if (item?.translatedText) {
            this._translations.set(pending[i].id, {
              translatedText: item.translatedText,
              provider: item.provider || '',
            });
          }
        }
        this._notifyBuffer();
      })
      .catch(() => {})
      .finally(() => {
        this._controllers.delete(controller);
        for (const s of pending) this._translatingIds.delete(s.id);
      });
  }

  /**
   * Sequentially pre-synthesize audio one sentence at a time starting from _bgAnchorIndex.
   * Ensures i+1 ALWAYS finishes before i+2 starts, preventing lock inversion on CPU TTS.
   */
  async _pumpAudioPrefetch(gen) {
    if (this._bgRunning) return;
    this._bgRunning = true;
    try {
      while (gen === this._generation) {
        const sentences = this._bgAnchorSentences;
        const start = this._bgAnchorIndex;
        const count = this._bgTargetCount;
        if (!Array.isArray(sentences) || start < 0 || count <= 0) break;

        let nextSentence = null;
        const limit = Math.min(sentences.length, start + count);
        for (let i = start; i < limit; i++) {
          const candidate = sentences[i];
          if (candidate && !this._cache.has(candidate.id)) {
            nextSentence = candidate;
            break;
          }
        }

        if (!nextSentence) break;
        try {
          await this._fetchOne(nextSentence, gen);
        } catch {
          // Stop background pump on abort or transient failure
          break;
        }
      }
    } finally {
      this._bgRunning = false;
    }
  }

  _scheduleAudioPipeline(sentences, startIndex, count, gen) {
    this._bgAnchorSentences = sentences;
    this._bgAnchorIndex = startIndex;
    this._bgTargetCount = count;
    if (!this._bgRunning && count > 0) {
      this._pumpAudioPrefetch(gen);
    }
  }

  /**
   * Proactively pre-translate a batch and sequentially pre-buffer the first few audio clips.
   */
  warm(sentences, startIndex = 0, audioCount = 3) {
    if (!Array.isArray(sentences) || startIndex < 0 || startIndex >= sentences.length) return;
    const gen = this._generation;
    this.warmTranslations(sentences, startIndex);
    this._scheduleAudioPipeline(sentences, startIndex, Math.min(audioCount, this.lookahead + 1), gen);
  }

  async get(sentences, index) {
    if (!Array.isArray(sentences) || index < 0 || index >= sentences.length) {
      throw new RangeError(`Sentence index ${index} out of bounds`);
    }
    const gen = this._generation;
    const current = sentences[index];

    // Stage 1: immediately trigger parallel multi-threaded translation ahead (non-blocking)
    this.warmTranslations(sentences, index);

    // Fetch current sentence with top priority
    const result = await this._fetchOne(current, gen);

    // Stage 2: strictly ordered sequential audio prefetch for i+1 .. i+lookahead
    if (gen === this._generation && this.lookahead > 0) {
      this._scheduleAudioPipeline(sentences, index + 1, this.lookahead, gen);
    }

    return result;
  }

  invalidate() {
    this._generation += 1;
    this._bgAnchorSentences = null;
    this._bgAnchorIndex = -1;
    this._bgTargetCount = 0;
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
    this._translations.clear();
    this._translatingIds.clear();
  }
}
