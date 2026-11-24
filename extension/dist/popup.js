// src/core/apiClient.js
var DEFAULT_BACKEND_URL = "http://127.0.0.1:8765";
var VieNeuApiClient = class {
  constructor(baseUrl = DEFAULT_BACKEND_URL) {
    this.baseUrl = (baseUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
  }
  setBaseUrl(url) {
    this.baseUrl = (url || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
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
  async readSentence(payload, signal) {
    const resp = await fetch(`${this.baseUrl}/api/read-sentence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal
    });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const errBody = await resp.json();
        if (errBody?.detail) detail = errBody.detail;
      } catch {
      }
      throw new Error(detail);
    }
    return await resp.json();
  }
  async uploadClonedVoice(name, file) {
    const form = new FormData();
    form.append("name", name);
    form.append("file", file);
    const resp = await fetch(`${this.baseUrl}/api/clone-voice`, {
      method: "POST",
      body: form
    });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const errBody = await resp.json();
        if (errBody?.detail) detail = errBody.detail;
      } catch {
      }
      throw new Error(detail);
    }
    return await resp.json();
  }
};

// src/popup/popup.js
var serverStatusEl = document.getElementById("serverStatus");
var statusTextEl = serverStatusEl.querySelector(".status-text");
var offlineHintEl = document.getElementById("offlineHint");
var openCurrentTabBtn = document.getElementById("openCurrentTabBtn");
var openCurrentLabel = document.getElementById("openCurrentLabel");
var openBlankReaderBtn = document.getElementById("openBlankReaderBtn");
var autoInterceptToggle = document.getElementById("autoInterceptToggle");
function isPdfUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.endsWith(".pdf") || lower.includes("arxiv.org/pdf/") || lower.includes(".pdf?") || lower.includes(".pdf#");
}
async function init() {
  const stored = await chrome.storage.local.get({
    backendUrl: DEFAULT_BACKEND_URL,
    autoInterceptPdf: false
  });
  autoInterceptToggle.checked = Boolean(stored.autoInterceptPdf);
  autoInterceptToggle.addEventListener("change", () => {
    chrome.storage.local.set({ autoInterceptPdf: autoInterceptToggle.checked });
  });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeUrl = tab?.url || "";
  if (isPdfUrl(activeUrl)) {
    openCurrentLabel.textContent = "\u0110\u1ECDc PDF \u1EDF tab hi\u1EC7n t\u1EA1i";
  } else {
    openCurrentLabel.textContent = "M\u1EDF VieNeu PDF Reader";
  }
  openCurrentTabBtn.addEventListener("click", () => {
    const pdfUrl = isPdfUrl(activeUrl) ? activeUrl : "";
    chrome.runtime.sendMessage({ type: "OPEN_VIEWER", pdfUrl });
    window.close();
  });
  openBlankReaderBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_VIEWER", pdfUrl: "" });
    window.close();
  });
  const api = new VieNeuApiClient(stored.backendUrl);
  try {
    const health = await api.checkHealth();
    serverStatusEl.className = "status-pill status-online";
    statusTextEl.textContent = health?.status === "healthy" ? "VieNeu s\u1EB5n s\xE0ng" : "\u0110\xE3 k\u1EBFt n\u1ED1i";
    offlineHintEl.hidden = true;
  } catch {
    serverStatusEl.className = "status-pill status-offline";
    statusTextEl.textContent = "Ch\u01B0a b\u1EADt server";
    offlineHintEl.hidden = false;
  }
}
init();
