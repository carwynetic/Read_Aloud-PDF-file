import { VieNeuApiClient, DEFAULT_BACKEND_URL } from '../core/apiClient.js';

const serverStatusEl = document.getElementById('serverStatus');
const statusTextEl = serverStatusEl.querySelector('.status-text');
const offlineHintEl = document.getElementById('offlineHint');
const openCurrentTabBtn = document.getElementById('openCurrentTabBtn');
const openCurrentLabel = document.getElementById('openCurrentLabel');
const openBlankReaderBtn = document.getElementById('openBlankReaderBtn');
const autoInterceptToggle = document.getElementById('autoInterceptToggle');

function isPdfUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.endsWith('.pdf') || lower.includes('arxiv.org/pdf/') || lower.includes('.pdf?') || lower.includes('.pdf#');
}

async function init() {
  const stored = await chrome.storage.local.get({
    backendUrl: DEFAULT_BACKEND_URL,
    autoInterceptPdf: false,
  });

  autoInterceptToggle.checked = Boolean(stored.autoInterceptPdf);
  autoInterceptToggle.addEventListener('change', () => {
    chrome.storage.local.set({ autoInterceptPdf: autoInterceptToggle.checked });
  });

  // Check active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeUrl = tab?.url || '';
  if (isPdfUrl(activeUrl)) {
    openCurrentLabel.textContent = 'Đọc PDF ở tab hiện tại';
  } else {
    openCurrentLabel.textContent = 'Mở VieNeu PDF Reader';
  }

  openCurrentTabBtn.addEventListener('click', () => {
    const pdfUrl = isPdfUrl(activeUrl) ? activeUrl : '';
    chrome.runtime.sendMessage({ type: 'OPEN_VIEWER', pdfUrl });
    window.close();
  });

  openBlankReaderBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_VIEWER', pdfUrl: '' });
    window.close();
  });

  // Check local backend health
  const api = new VieNeuApiClient(stored.backendUrl);
  try {
    const health = await api.checkHealth();
    serverStatusEl.className = 'status-pill status-online';
    statusTextEl.textContent = health?.status === 'healthy' ? 'VieNeu sẵn sàng' : 'Đã kết nối';
    offlineHintEl.hidden = true;
  } catch {
    serverStatusEl.className = 'status-pill status-offline';
    statusTextEl.textContent = 'Chưa bật server';
    offlineHintEl.hidden = false;
  }
}

init();
