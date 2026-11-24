/**
 * API client for the local VieNeu Read Aloud FastAPI backend.
 */

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8765';

export class VieNeuApiClient {
  constructor(baseUrl = DEFAULT_BACKEND_URL) {
    this.baseUrl = (baseUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
  }

  setBaseUrl(url) {
    this.baseUrl = (url || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
  }

  async checkHealth() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const resp = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async getVoices() {
    const resp = await fetch(`${this.baseUrl}/api/voices`);
    if (!resp.ok) throw new Error(`Failed to fetch voices (HTTP ${resp.status})`);
    return await resp.json();
  }

  async translate(payload, signal) {
    const resp = await fetch(`${this.baseUrl}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  }

  async readSentence(payload, signal) {
    const resp = await fetch(`${this.baseUrl}/api/read-sentence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const errBody = await resp.json();
        if (errBody?.detail) detail = errBody.detail;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }
    return await resp.json();
  }

  async uploadClonedVoice(name, file) {
    const form = new FormData();
    form.append('name', name);
    form.append('file', file);
    const resp = await fetch(`${this.baseUrl}/api/clone-voice`, {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const errBody = await resp.json();
        if (errBody?.detail) detail = errBody.detail;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }
    return await resp.json();
  }
}
