import * as pdfjsLib from 'pdfjs-dist';
import {
  analyzeDocumentPages,
  extractFigureBoxesFromPdfPage,
} from '../core/pdfLayoutAnalyzer.js';
import { getSyncStateAtTime } from '../core/wordSyncEngine.js';
import { PrefetchQueue } from '../core/prefetchQueue.js';
import { VieNeuApiClient, DEFAULT_BACKEND_URL } from '../core/apiClient.js';

// Configure PDF.js worker bundled right next to viewer.js
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

// ============================================================================
// Persistent settings (works in Chrome Extension AND standalone preview)
// ============================================================================
const DEFAULT_SETTINGS = {
  backendUrl: DEFAULT_BACKEND_URL,
  voice: 'hai_dang',
  speed: 1.0,
  provider: 'google',
  openaiBaseUrl: '',
  openaiModel: '',
  openaiApiKey: '',
  highlightMode: 'all', // 'all' | 'sentence-word' | 'sentence'
  focusDim: true,
  showSubtitle: true,
  showSkipped: false,
  skipHeadersFooters: true,
  skipPageNumbers: true,
  skipFigures: true,
  skipFootnotes: true,
  theme: 'light',
};

async function loadSettings() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return await chrome.storage.local.get(DEFAULT_SETTINGS);
  }
  try {
    const raw = localStorage.getItem('vieneu_readaloud_settings');
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(partial) {
  Object.assign(state.settings, partial);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set(partial);
  } else {
    try {
      localStorage.setItem('vieneu_readaloud_settings', JSON.stringify(state.settings));
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// Application State
// ============================================================================
const state = {
  settings: { ...DEFAULT_SETTINGS },
  api: new VieNeuApiClient(DEFAULT_BACKEND_URL),
  pdfDoc: null,
  rawPages: [],
  analyzed: null,
  pageViews: new Map(), // pageNumber -> { card, width, height, focusSvg, hlLayer, skipLayer, interactiveLayer, wordCursor }
  zoom: 1.25,
  currentSentenceIndex: 0,
  isPlaying: false,
  isLoadingAudio: false,
  audioEl: new Audio(),
  activeAudioUrl: null,
  activePayload: null,
  rafId: null,
  prefetchQueue: null,
};

state.audioEl.preservesPitch = true;
if ('webkitPreservesPitch' in state.audioEl) {
  state.audioEl.webkitPreservesPitch = true;
}

// ============================================================================
// DOM References
// ============================================================================
const el = {
  waveformIcon: document.getElementById('waveformIcon'),
  backendChip: document.getElementById('backendChip'),
  pageIndicator: document.getElementById('pageIndicator'),
  skipInspectBtn: document.getElementById('skipInspectBtn'),
  skipCountLabel: document.getElementById('skipCountLabel'),
  prevBtn: document.getElementById('prevBtn'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  nextBtn: document.getElementById('nextBtn'),
  zoomOutBtn: document.getElementById('zoomOutBtn'),
  zoomInBtn: document.getElementById('zoomInBtn'),
  zoomReadout: document.getElementById('zoomReadout'),
  focusDimBtn: document.getElementById('focusDimBtn'),
  subtitleToggleBtn: document.getElementById('subtitleToggleBtn'),
  voiceOptionsBtn: document.getElementById('voiceOptionsBtn'),
  openFileBtn: document.getElementById('openFileBtn'),
  hiddenFileInput: document.getElementById('hiddenFileInput'),
  optionsPopover: document.getElementById('optionsPopover'),
  closeOptionsBtn: document.getElementById('closeOptionsBtn'),
  voiceSelect: document.getElementById('voiceSelect'),
  speedSlider: document.getElementById('speedSlider'),
  speedValue: document.getElementById('speedValue'),
  optSkipHeaders: document.getElementById('optSkipHeaders'),
  optSkipPageNums: document.getElementById('optSkipPageNums'),
  optSkipFigures: document.getElementById('optSkipFigures'),
  optSkipFootnotes: document.getElementById('optSkipFootnotes'),
  providerSelect: document.getElementById('providerSelect'),
  llmConfigGroup: document.getElementById('llmConfigGroup'),
  llmBaseUrl: document.getElementById('llmBaseUrl'),
  llmModel: document.getElementById('llmModel'),
  llmApiKey: document.getElementById('llmApiKey'),
  cloneNameInput: document.getElementById('cloneNameInput'),
  cloneFileInput: document.getElementById('cloneFileInput'),
  cloneUploadBtn: document.getElementById('cloneUploadBtn'),
  cloneStatus: document.getElementById('cloneStatus'),
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  backendUrlInput: document.getElementById('backendUrlInput'),
  reconnectBtn: document.getElementById('reconnectBtn'),
  emptyStage: document.getElementById('emptyStage'),
  dropZone: document.getElementById('dropZone'),
  pickPdfBtn: document.getElementById('pickPdfBtn'),
  loadDemoBtn: document.getElementById('loadDemoBtn'),
  urlLoadForm: document.getElementById('urlLoadForm'),
  pdfUrlInput: document.getElementById('pdfUrlInput'),
  pdfScroll: document.getElementById('pdfScroll'),
  pagesStack: document.getElementById('pagesStack'),
  captionDock: document.getElementById('captionDock'),
  captionProgressBadge: document.getElementById('captionProgressBadge'),
  captionStateText: document.getElementById('captionStateText'),
  hideCaptionBtn: document.getElementById('hideCaptionBtn'),
  captionViText: document.getElementById('captionViText'),
  captionEnText: document.getElementById('captionEnText'),
  captionProgressFill: document.getElementById('captionProgressFill'),
  toast: document.getElementById('toast'),
};

let toastTimer = null;
function showToast(message, durationMs = 3200) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, durationMs);
}

// ============================================================================
// Backend Connection & Voices (with automatic reconnect / warm-up polling)
// ============================================================================
let healthPollTimer = null;

function scheduleBackendPoll(delayMs = 2500) {
  clearTimeout(healthPollTimer);
  healthPollTimer = setTimeout(() => {
    connectBackend(true);
  }, delayMs);
}

async function connectBackend(silent = false) {
  clearTimeout(healthPollTimer);
  state.api.setBaseUrl(state.settings.backendUrl);
  const label = el.backendChip.querySelector('.status-label');
  if (!silent) {
    el.backendChip.className = 'status-chip';
    label.textContent = 'Đang kết nối…';
  }

  try {
    const health = await state.api.checkHealth();
    if (health?.status === 'warming_up' || health?.ready === false) {
      el.backendChip.className = 'status-chip';
      label.textContent = 'Đang nạp VieNeu…';
      scheduleBackendPoll(2000);
      return;
    }
    el.backendChip.className = 'status-chip is-online';
    label.textContent = 'VieNeu sẵn sàng';
    await refreshVoices();
  } catch {
    el.backendChip.className = 'status-chip is-offline';
    label.textContent = 'Chưa bật server';
    scheduleBackendPoll(2500);
  }
}

async function refreshVoices() {
  try {
    const data = await state.api.getVoices();
    const presets = data.presets || [];
    const cloned = data.cloned || [];
    if (!presets.length && !cloned.length) return;

    const currentVal = state.settings.voice;
    el.voiceSelect.innerHTML = '';

    if (presets.length) {
      const grp = document.createElement('optgroup');
      grp.label = 'Giọng VieNeu-TTS mặc định';
      for (const v of presets) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name;
        grp.appendChild(opt);
      }
      el.voiceSelect.appendChild(grp);
    }

    if (cloned.length) {
      const grp = document.createElement('optgroup');
      grp.label = 'Giọng đã clone (Instant Voice Cloning)';
      for (const v of cloned) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name;
        grp.appendChild(opt);
      }
      el.voiceSelect.appendChild(grp);
    }

    const normalizeVoice = (str) =>
      String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');

    const options = Array.from(el.voiceSelect.options);
    const wantedNorm = normalizeVoice(currentVal);
    const matched =
      options.find((o) => o.value === currentVal) ||
      options.find((o) => normalizeVoice(o.value) === wantedNorm) ||
      options.find((o) => normalizeVoice(o.textContent).includes(wantedNorm)) ||
      options.find((o) => normalizeVoice(o.value).includes('haidang')) ||
      options.find((o) => normalizeVoice(o.value).includes('maianh')) ||
      options.find((o) => normalizeVoice(o.value).includes('trucly')) ||
      options[0];

    el.voiceSelect.value = matched?.value || 'hai_dang';
    if (el.voiceSelect.value !== state.settings.voice) {
      saveSettings({ voice: el.voiceSelect.value });
    }
  } catch {
    // keep static fallback options
  }
}

function buildPrefetchQueue() {
  if (state.prefetchQueue) state.prefetchQueue.invalidate();
  state.prefetchQueue = new PrefetchQueue({
    lookahead: 2,
    fetcher: (sentence, signal) => {
      const s = state.settings;
      return state.api.readSentence(
        {
          text: sentence.text,
          voice: s.voice,
          translate: s.provider !== 'passthrough',
          provider: s.provider,
          source_lang: 'en',
          target_lang: 'vi',
          openai_base_url: s.openaiBaseUrl || undefined,
          openai_model: s.openaiModel || undefined,
          openai_api_key: s.openaiApiKey || undefined,
        },
        signal
      );
    },
  });
}

// ============================================================================
// PDF Loading, Rendering & Layout Analysis
// ============================================================================
async function loadPdfFromBytes(uint8Array, displayName = 'Tài liệu PDF') {
  stopPlayback();
  showToast(`Đang phân tích bố cục ${displayName}…`, 2400);

  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdfDoc = await loadingTask.promise;
  state.pdfDoc = pdfDoc;
  document.title = `${displayName} — VieNeu Read Aloud`;

  el.emptyStage.hidden = true;
  el.pdfScroll.hidden = false;
  el.pageIndicator.hidden = false;
  el.skipInspectBtn.hidden = false;
  el.captionDock.hidden = !state.settings.showSubtitle;

  await renderAllPagesAndAnalyze();
  showToast(
    `Đã sẵn sàng ${state.analyzed.stats.totalSentences} câu đọc · Tự động bỏ qua ${state.analyzed.stats.totalSkipped} mục không phải nội dung chính.`,
    3600
  );
}

async function loadPdfFromUrl(url) {
  if (!url) return;
  try {
    let bytes;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch {
      // Fallback through extension service worker for cross-origin PDFs
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const res = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'FETCH_PDF_ARRAYBUFFER', url }, resolve)
        );
        if (!res?.ok) throw new Error(res?.error || 'Không tải được PDF từ liên kết này.');
        const bin = atob(res.base64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        throw new Error('Không thể tải PDF do giới hạn CORS. Hãy tải file về và kéo thả vào đây.');
      }
    }
    const cleanName = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'PDF');
    await loadPdfFromBytes(bytes, cleanName);
  } catch (err) {
    showToast(`Lỗi mở PDF: ${err.message}`, 4800);
  }
}

async function renderAllPagesAndAnalyze() {
  if (!state.pdfDoc) return;
  el.pagesStack.innerHTML = '';
  state.pageViews.clear();
  state.rawPages = [];

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const numPages = state.pdfDoc.numPages;
  el.pageIndicator.textContent = `Trang 1 / ${numPages}`;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: state.zoom });

    const card = document.createElement('article');
    card.className = 'pdf-page-card';
    card.dataset.pageNumber = String(pageNum);
    card.style.width = `${viewport.width}px`;
    card.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // SVG Focus Dim mask layer
    const svgNS = 'http://www.w3.org/2000/svg';
    const focusSvg = document.createElementNS(svgNS, 'svg');
    focusSvg.setAttribute('class', 'layer-focus-dim');
    focusSvg.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
    focusSvg.setAttribute('width', String(viewport.width));
    focusSvg.setAttribute('height', String(viewport.height));

    const hlLayer = document.createElement('div');
    hlLayer.className = 'layer-highlights';

    const wordCursor = document.createElement('div');
    wordCursor.className = 'hl-word-cursor';
    hlLayer.appendChild(wordCursor);

    const skipLayer = document.createElement('div');
    skipLayer.className = 'layer-skip';

    const interactiveLayer = document.createElement('div');
    interactiveLayer.className = 'layer-interactive';

    card.append(canvas, focusSvg, hlLayer, skipLayer, interactiveLayer);
    el.pagesStack.appendChild(card);

    state.pageViews.set(pageNum, {
      card,
      width: viewport.width,
      height: viewport.height,
      focusSvg,
      hlLayer,
      skipLayer,
      interactiveLayer,
      wordCursor,
    });

    // Extract text items in top-down viewport coordinates (flagging rotated margin stamps)
    const textContent = await page.getTextContent();
    const items = [];
    for (const raw of textContent.items) {
      if (!raw || typeof raw.str !== 'string' || !raw.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, raw.transform);
      const isRotated = Math.abs(tx[1]) > Math.abs(tx[0]) * 0.55;
      const fontHeight = Math.hypot(tx[2], tx[3]) || Math.abs(tx[0]) || 11;
      const width = Math.max(1, (raw.width || 0) * viewport.scale);
      const x = isRotated ? Math.max(0, tx[4] - fontHeight) : tx[4];
      const y = isRotated ? Math.max(0, tx[5] - width) : tx[5] - fontHeight * 0.86;
      items.push({
        str: raw.str,
        x,
        y,
        width: isRotated ? fontHeight * 1.1 : width,
        height: isRotated ? Math.max(fontHeight, width) : fontHeight * 1.05,
        rotated: isRotated,
      });
    }

    const figureBoxes = await extractFigureBoxesFromPdfPage(page, viewport, pdfjsLib.OPS);
    state.rawPages.push({
      pageNumber: pageNum,
      width: viewport.width,
      height: viewport.height,
      items,
      figureBoxes,
    });
  }

  reanalyzeLayout(true);
}

function reanalyzeLayout(resetIndex = false) {
  if (!state.rawPages.length) return;
  const s = state.settings;
  state.analyzed = analyzeDocumentPages(state.rawPages, {
    skipHeadersFooters: s.skipHeadersFooters,
    skipPageNumbers: s.skipPageNumbers,
    skipFigures: s.skipFigures,
    skipFootnotes: s.skipFootnotes,
  });

  if (resetIndex || state.currentSentenceIndex >= state.analyzed.sentences.length) {
    state.currentSentenceIndex = 0;
  }

  buildPrefetchQueue();
  renderInteractiveAndSkipLayers();
  updateTransportButtons();

  el.skipCountLabel.textContent = `Đã bỏ qua ${state.analyzed.stats.totalSkipped} mục`;
  if (state.analyzed.sentences.length > 0) {
    const active = state.analyzed.sentences[state.currentSentenceIndex];
    renderSentenceHighlights(active, null);
    updateCaptionIdle(active);
  }
}

const SKIP_LABELS_VI = {
  header: 'Header',
  footer: 'Footer',
  'page-number': 'Số trang',
  figure: 'Hình vẽ',
  caption: 'Chú thích',
  footnote: 'Footnote',
  watermark: 'Watermark',
};

function renderInteractiveAndSkipLayers() {
  for (const pv of state.pageViews.values()) {
    pv.interactiveLayer.innerHTML = '';
    pv.skipLayer.innerHTML = '';
  }

  if (!state.analyzed) return;

  // Render clickable hitboxes for every readable sentence
  for (const sent of state.analyzed.sentences) {
    const pv = state.pageViews.get(sent.pageNumber);
    if (!pv) continue;
    for (const r of sent.rects) {
      const box = document.createElement('div');
      box.className = 'sent-hitbox';
      box.style.left = `${r.x * pv.width - 2}px`;
      box.style.top = `${r.y * pv.height - 2}px`;
      box.style.width = `${r.width * pv.width + 4}px`;
      box.style.height = `${r.height * pv.height + 4}px`;
      box.title = 'Click để đọc tiếng Việt từ câu này';
      box.addEventListener('click', () => jumpAndPlay(sent.index));
      pv.interactiveLayer.appendChild(box);
    }
  }

  // Render skipped region inspector overlays (de-duplicate stacked tags on adjacent lines)
  const placedTagsByPage = new Map();
  for (const reg of state.analyzed.skippedRegions) {
    const pv = state.pageViews.get(reg.pageNumber);
    if (!pv) continue;
    const xPx = reg.rect.x * pv.width - 2;
    const yPx = reg.rect.y * pv.height - 2;
    const wPx = reg.rect.width * pv.width + 4;
    const hPx = reg.rect.height * pv.height + 4;

    const box = document.createElement('div');
    box.className = 'skip-box';
    box.style.left = `${xPx}px`;
    box.style.top = `${yPx}px`;
    box.style.width = `${wPx}px`;
    box.style.height = `${hPx}px`;

    const placed = placedTagsByPage.get(reg.pageNumber) || [];
    const collides = placed.some(
      (p) =>
        p.reason === reg.reason &&
        Math.abs(p.y - yPx) < 28 &&
        Math.abs(p.x - xPx) < 120
    );
    if (!collides) {
      const tag = document.createElement('span');
      tag.className = 'skip-tag';
      tag.textContent = SKIP_LABELS_VI[reg.reason] || reg.reason;
      box.appendChild(tag);
      placed.push({ reason: reg.reason, x: xPx, y: yPx });
      placedTagsByPage.set(reg.pageNumber, placed);
    }
    pv.skipLayer.appendChild(box);
  }
}

// ============================================================================
// 3-Tier Synchronized Highlight Rendering (Paragraph + Sentence + Word + Dim)
// ============================================================================
function clearAllHighlights() {
  for (const pv of state.pageViews.values()) {
    pv.hlLayer.querySelectorAll('.hl-para-rect, .hl-sent-rect').forEach((n) => n.remove());
    pv.wordCursor.classList.remove('is-visible');
    pv.focusSvg.classList.remove('is-active');
    pv.focusSvg.innerHTML = '';
  }
}

function renderSentenceHighlights(sentence, activeWordBox = null, shouldScroll = false) {
  clearAllHighlights();
  if (!sentence || !state.analyzed) return;

  const pv = state.pageViews.get(sentence.pageNumber);
  if (!pv) return;

  const mode = state.settings.highlightMode;
  const para = state.analyzed.paragraphs.find((p) => p.id === sentence.paragraphId);

  // 1. Paragraph wash
  if (mode === 'all' && para) {
    for (const r of para.rects) {
      const div = document.createElement('div');
      div.className = 'hl-para-rect';
      div.style.left = `${r.x * pv.width - 4}px`;
      div.style.top = `${r.y * pv.height - 2}px`;
      div.style.width = `${r.width * pv.width + 8}px`;
      div.style.height = `${r.height * pv.height + 4}px`;
      pv.hlLayer.insertBefore(div, pv.wordCursor);
    }
  }

  // 2. Sentence highlight
  for (const r of sentence.rects) {
    const div = document.createElement('div');
    div.className = 'hl-sent-rect';
    div.style.left = `${r.x * pv.width - 3}px`;
    div.style.top = `${r.y * pv.height - 2}px`;
    div.style.width = `${r.width * pv.width + 6}px`;
    div.style.height = `${r.height * pv.height + 4}px`;
    pv.hlLayer.insertBefore(div, pv.wordCursor);
  }

  // 3. Focus Dim SVG cutout mask (keeps active paragraph/sentence crisp while dimming surroundings)
  if (state.settings.focusDim) {
    const cutouts = mode === 'all' && para ? para.rects : sentence.rects;
    for (const [pageNum, view] of state.pageViews.entries()) {
      const maskId = `focus-mask-${pageNum}`;
      const holes =
        pageNum === sentence.pageNumber
          ? cutouts
              .map((r) => {
                const x = Math.max(0, r.x * view.width - 8);
                const y = Math.max(0, r.y * view.height - 5);
                const w = r.width * view.width + 16;
                const h = r.height * view.height + 10;
                return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="black" />`;
              })
              .join('')
          : '';
      view.focusSvg.innerHTML = `
        <defs>
          <mask id="${maskId}">
            <rect width="100%" height="100%" fill="white" />
            ${holes}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="var(--focus-dim)" mask="url(#${maskId})" />
      `;
      view.focusSvg.classList.add('is-active');
    }
  }

  // 4. Active sliding word cursor
  if (activeWordBox && mode !== 'sentence') {
    updateWordCursor(pv, activeWordBox);
  }

  // Update page counter & auto-scroll smoothly
  el.pageIndicator.textContent = `Trang ${sentence.pageNumber} / ${state.pdfDoc.numPages}`;
  if (shouldScroll && sentence.rects.length > 0) {
    const targetY = pv.card.offsetTop + sentence.rects[0].y * pv.height;
    const desiredScrollTop = Math.max(0, targetY - el.pdfScroll.clientHeight * 0.34);
    el.pdfScroll.scrollTo({ top: desiredScrollTop, behavior: 'smooth' });
  }
}

function updateWordCursor(pv, wordBox) {
  if (!pv || !wordBox || state.settings.highlightMode === 'sentence') return;
  const x = wordBox.x * pv.width - 2.5;
  const y = wordBox.y * pv.height - 2;
  const w = Math.max(8, wordBox.width * pv.width + 5);
  const h = Math.max(12, wordBox.height * pv.height + 4);
  pv.wordCursor.style.width = `${w}px`;
  pv.wordCursor.style.height = `${h}px`;
  pv.wordCursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  pv.wordCursor.classList.add('is-visible');
}

// ============================================================================
// Audio Playback, Vietnamese Karaoke Caption & Real-time Word Sync Loop
// ============================================================================
function updateTransportButtons() {
  const hasDoc = Boolean(state.analyzed && state.analyzed.sentences.length > 0);
  el.playPauseBtn.disabled = !hasDoc;
  el.prevBtn.disabled = !hasDoc || state.currentSentenceIndex <= 0;
  el.nextBtn.disabled =
    !hasDoc || state.currentSentenceIndex >= (state.analyzed?.sentences.length || 1) - 1;

  el.playPauseBtn.classList.toggle('is-playing', state.isPlaying && !state.isLoadingAudio);
  el.playPauseBtn.classList.toggle('is-loading', state.isLoadingAudio);
  el.waveformIcon.classList.toggle('is-speaking', state.isPlaying && !state.isLoadingAudio);
}

function updateCaptionIdle(sentence) {
  if (!sentence || !state.analyzed) return;
  el.captionProgressBadge.textContent = `Câu ${sentence.index + 1} / ${state.analyzed.sentences.length}`;
  el.captionStateText.textContent = 'Sẵn sàng';
  el.captionEnText.textContent = sentence.text;
  el.captionProgressFill.style.transform = 'scaleX(0)';
}

function renderVietnameseKaraoke(wordTimings, fallbackText) {
  el.captionViText.classList.remove('is-loading');
  el.captionViText.innerHTML = '';

  if (Array.isArray(wordTimings) && wordTimings.length > 0) {
    wordTimings.forEach((wt, i) => {
      const span = document.createElement('span');
      span.className = 'vi-word is-upcoming';
      span.dataset.idx = String(i);
      span.textContent = wt.word;
      el.captionViText.appendChild(span);
      if (i < wordTimings.length - 1) {
        el.captionViText.appendChild(document.createTextNode(' '));
      }
    });
  } else {
    el.captionViText.textContent = fallbackText || '';
  }
}

function updateKaraokeActiveWord(activeIdx) {
  const spans = el.captionViText.querySelectorAll('.vi-word');
  spans.forEach((span, idx) => {
    span.classList.toggle('is-active', idx === activeIdx);
    span.classList.toggle('is-spoken', idx < activeIdx);
    span.classList.toggle('is-upcoming', idx > activeIdx);
  });
}

function stopSyncLoop() {
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

function startSyncLoop(sentence, payload) {
  stopSyncLoop();
  const pv = state.pageViews.get(sentence.pageNumber);

  const tick = () => {
    if (!state.isPlaying) return;
    const currentMs = (state.audioEl.currentTime || 0) * 1000;
    const durationMs =
      Number.isFinite(state.audioEl.duration) && state.audioEl.duration > 0
        ? state.audioEl.duration * 1000
        : payload.durationMs || 1000;

    const sync = getSyncStateAtTime(
      currentMs,
      durationMs,
      payload.wordTimings || [],
      sentence.words || []
    );

    updateKaraokeActiveWord(sync.viWordIndex);
    if (pv && sync.activeSourceWord) {
      updateWordCursor(pv, sync.activeSourceWord);
    }
    el.captionProgressFill.style.transform = `scaleX(${Math.max(0, Math.min(1, sync.progress))})`;

    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

function base64ToBlobUrl(b64, mime = 'audio/wav') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function revokeAudioUrl() {
  if (state.activeAudioUrl) {
    URL.revokeObjectURL(state.activeAudioUrl);
    state.activeAudioUrl = null;
  }
}

function stopPlayback() {
  state.isPlaying = false;
  state.isLoadingAudio = false;
  stopSyncLoop();
  state.audioEl.pause();
  state.audioEl.currentTime = 0;
  revokeAudioUrl();
  updateTransportButtons();
}

async function playSentenceAt(index) {
  if (!state.analyzed || index < 0 || index >= state.analyzed.sentences.length) {
    stopPlayback();
    showToast('Đã đọc hết tài liệu.');
    return;
  }

  state.currentSentenceIndex = index;
  state.isPlaying = true;
  state.isLoadingAudio = true;
  stopSyncLoop();
  state.audioEl.pause();
  revokeAudioUrl();

  const sentence = state.analyzed.sentences[index];
  renderSentenceHighlights(sentence, sentence.words[0] || null, true);
  updateTransportButtons();

  el.captionProgressBadge.textContent = `Câu ${index + 1} / ${state.analyzed.sentences.length}`;
  el.captionStateText.textContent = 'Đang dịch & tạo giọng VieNeu-TTS…';
  el.captionViText.classList.add('is-loading');
  el.captionViText.textContent = 'Đang dịch sang tiếng Việt và tổng hợp giọng đọc…';
  el.captionEnText.textContent = sentence.text;
  el.captionProgressFill.style.transform = 'scaleX(0)';

  try {
    const payload = await state.prefetchQueue.get(state.analyzed.sentences, index);
    if (!state.isPlaying || state.currentSentenceIndex !== index) return;

    state.activePayload = payload;
    state.isLoadingAudio = false;
    updateTransportButtons();

    renderVietnameseKaraoke(payload.wordTimings, payload.translatedText);
    el.captionStateText.textContent = payload.cached
      ? `VieNeu-TTS · Cache (${payload.voice})`
      : `VieNeu-TTS · ${payload.latencyMs || 0}ms (${payload.voice})`;

    state.activeAudioUrl = base64ToBlobUrl(payload.audioBase64, 'audio/wav');
    state.audioEl.src = state.activeAudioUrl;
    state.audioEl.playbackRate = state.settings.speed;
    await state.audioEl.play();
    startSyncLoop(sentence, payload);
  } catch (err) {
    if (err?.name === 'AbortError' || String(err?.message).includes('Aborted')) return;
    state.isPlaying = false;
    state.isLoadingAudio = false;
    updateTransportButtons();
    el.captionStateText.textContent = 'Lỗi kết nối VieNeu-TTS';
    el.captionViText.textContent = `Không thể tạo giọng đọc: ${err.message}. Hãy đảm bảo server local đang chạy (start-vieneu-readaloud.bat).`;
    showToast(`Lỗi VieNeu-TTS: ${err.message}`, 4500);
  }
}

function togglePlayPause() {
  if (!state.analyzed?.sentences.length) return;
  if (state.isPlaying) {
    state.isPlaying = false;
    stopSyncLoop();
    state.audioEl.pause();
    el.captionStateText.textContent = 'Đã tạm dừng';
    updateTransportButtons();
  } else if (state.activeAudioUrl && state.audioEl.currentTime > 0 && !state.audioEl.ended) {
    state.isPlaying = true;
    state.audioEl.playbackRate = state.settings.speed;
    state.audioEl.play();
    const sent = state.analyzed.sentences[state.currentSentenceIndex];
    if (sent && state.activePayload) startSyncLoop(sent, state.activePayload);
    el.captionStateText.textContent = 'Đang đọc…';
    updateTransportButtons();
  } else {
    playSentenceAt(state.currentSentenceIndex);
  }
}

function jumpAndPlay(index) {
  if (!state.analyzed) return;
  const clamped = Math.max(0, Math.min(state.analyzed.sentences.length - 1, index));
  playSentenceAt(clamped);
}

state.audioEl.addEventListener('ended', () => {
  if (!state.isPlaying) return;
  stopSyncLoop();
  el.captionProgressFill.style.transform = 'scaleX(1)';
  if (state.currentSentenceIndex + 1 < (state.analyzed?.sentences.length || 0)) {
    playSentenceAt(state.currentSentenceIndex + 1);
  } else {
    stopPlayback();
    el.captionStateText.textContent = 'Hoàn tất tài liệu';
    showToast('Đã đọc hết tài liệu.');
  }
});

// ============================================================================
// Built-in Synthetic 2-Column Academic PDF Generator (1-Click Instant Demo)
// ============================================================================
function buildSampleAcademicPdfBytes() {
  // Valid minimal PDF 1.4 with running header, 2-column body, figure + caption, footnote & page number
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const textOp = (x, y, size, str) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(str)}) Tj ET`;

  const streamLines = [
    // Running header (y=765 in bottom-up PDF coords -> top ~3.4% of 792pt page)
    textOp(135, 765, 9, 'A Simple Framework for Contrastive Learning of Visual Representations'),
    '0.75 0.78 0.76 RG 0.6 w 55 756 m 555 756 l S',

    // Title
    textOp(55, 718, 15, 'A Simple Framework for Contrastive Learning'),

    // Left column body
    textOp(55, 682, 10.5, 'Generative approaches learn to generate or'),
    textOp(55, 666, 10.5, 'otherwise model pixels in the input space.'),
    textOp(55, 650, 10.5, 'However, pixel-level generation is compu-'),
    textOp(55, 634, 10.5, 'tationally expensive and may not be'),
    textOp(55, 618, 10.5, 'necessary for representation learning.'),

    textOp(55, 586, 10.5, 'In this paper, we present SimCLR, a simple'),
    textOp(55, 570, 10.5, 'framework for contrastive learning of'),
    textOp(55, 554, 10.5, 'visual representations without requiring'),
    textOp(55, 538, 10.5, 'specialized architectures or memory banks.'),

    // Right column body
    textOp(320, 682, 10.5, 'Composition of multiple data augmentation'),
    textOp(320, 666, 10.5, 'operations is crucial in defining effective'),
    textOp(320, 650, 10.5, 'contrastive prediction tasks. In addition,'),
    textOp(320, 634, 10.5, 'unsupervised contrastive learning benefits'),
    textOp(320, 618, 10.5, 'from stronger data augmentation than'),
    textOp(320, 602, 10.5, 'supervised learning.'),

    // Simulated Figure box with diagram image XObject + Caption
    'q 220 0 0 110 320 450 cm /Im1 Do Q',
    textOp(382, 532, 9, 'Maximize agreement'),
    textOp(346, 494, 9, 'hi -> zi'),
    textOp(462, 494, 9, 'hj -> zj'),
    textOp(320, 434, 8.8, 'Figure 1: A simple framework for contrastive'),
    textOp(320, 422, 8.8, 'learning of visual representations.'),

    // Right column body continuing below caption
    textOp(320, 386, 10.5, 'Finally, introducing a learnable nonlinear'),
    textOp(320, 370, 10.5, 'transformation between the representation'),
    textOp(320, 354, 10.5, 'and the contrastive loss substantially'),
    textOp(320, 338, 10.5, 'improves the quality of learned features.'),

    // Footnote & conference footer (bottom ~10% of page)
    '0.75 0.78 0.76 RG 0.5 w 55 124 m 245 124 l S',
    textOp(55, 110, 8, '1Google Research, Brain Team. Correspondence to: author@google.com.'),
    textOp(55, 92, 8, 'Proceedings of the 37th International Conference on Machine Learning, 2020.'),
    textOp(55, 80, 8, 'Copyright 2020 by the author(s).'),
    textOp(300, 34, 9, '1'),
  ];
  const contentStream = streamLines.join('\n');

  // Simple 2x2 light sage RGB image XObject for Figure 1 so PDF.js OPS.paintImageXObject detects it!
  const imgData = String.fromCharCode(232, 240, 234, 232, 240, 234, 224, 235, 227, 224, 235, 227);

  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${contentStream.length} >> stream\n${contentStream}\nendstream endobj`,
    `6 0 obj << /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imgData.length} >> stream\n${imgData}\nendstream endobj`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj + '\n';
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  const out = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) out[i] = pdf.charCodeAt(i) & 0xff;
  return out;
}

// ============================================================================
// UI Event Bindings
// ============================================================================
function applySettingsToUi() {
  const s = state.settings;
  document.body.dataset.theme = s.theme;
  el.themeToggleBtn.textContent = s.theme === 'dusk' ? 'Dịu mắt (Tối)' : 'Ban ngày';
  el.speedSlider.value = String(s.speed);
  el.speedValue.textContent = `${Number(s.speed).toFixed(2)}×`;
  el.providerSelect.value = s.provider;
  el.llmConfigGroup.hidden = s.provider !== 'openai';
  el.llmBaseUrl.value = s.openaiBaseUrl || '';
  el.llmModel.value = s.openaiModel || '';
  el.llmApiKey.value = s.openaiApiKey || '';
  el.backendUrlInput.value = s.backendUrl;
  el.optSkipHeaders.checked = s.skipHeadersFooters;
  el.optSkipPageNums.checked = s.skipPageNumbers;
  el.optSkipFigures.checked = s.skipFigures;
  el.optSkipFootnotes.checked = s.skipFootnotes;
  el.focusDimBtn.setAttribute('aria-pressed', String(s.focusDim));
  el.subtitleToggleBtn.setAttribute('aria-pressed', String(s.showSubtitle));
  el.skipInspectBtn.setAttribute('aria-pressed', String(s.showSkipped));
  el.pagesStack.classList.toggle('show-skipped', s.showSkipped);

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.hlMode === s.highlightMode);
  });
}

function bindEvents() {
  el.playPauseBtn.addEventListener('click', togglePlayPause);
  el.prevBtn.addEventListener('click', () => jumpAndPlay(state.currentSentenceIndex - 1));
  el.nextBtn.addEventListener('click', () => jumpAndPlay(state.currentSentenceIndex + 1));

  // Zoom controls
  const applyZoom = async (delta) => {
    const next = Math.max(0.75, Math.min(2.25, Math.round((state.zoom + delta) * 100) / 100));
    if (next === state.zoom) return;
    state.zoom = next;
    el.zoomReadout.textContent = `${Math.round(next * 100)}%`;
    if (state.pdfDoc) {
      const savedIdx = state.currentSentenceIndex;
      await renderAllPagesAndAnalyze();
      state.currentSentenceIndex = Math.min(savedIdx, Math.max(0, (state.analyzed?.sentences.length || 1) - 1));
      const active = state.analyzed?.sentences[state.currentSentenceIndex];
      if (active) renderSentenceHighlights(active, null, true);
    }
  };
  el.zoomOutBtn.addEventListener('click', () => applyZoom(-0.15));
  el.zoomInBtn.addEventListener('click', () => applyZoom(0.15));

  // Focus Dim, Subtitle, Skip inspector toggles
  el.focusDimBtn.addEventListener('click', () => {
    const next = !state.settings.focusDim;
    saveSettings({ focusDim: next });
    el.focusDimBtn.setAttribute('aria-pressed', String(next));
    const active = state.analyzed?.sentences[state.currentSentenceIndex];
    if (active) renderSentenceHighlights(active, null, false);
  });

  const toggleSubtitle = () => {
    const next = !state.settings.showSubtitle;
    saveSettings({ showSubtitle: next });
    el.subtitleToggleBtn.setAttribute('aria-pressed', String(next));
    if (state.pdfDoc) el.captionDock.hidden = !next;
  };
  el.subtitleToggleBtn.addEventListener('click', toggleSubtitle);
  el.hideCaptionBtn.addEventListener('click', toggleSubtitle);

  el.skipInspectBtn.addEventListener('click', () => {
    const next = !state.settings.showSkipped;
    saveSettings({ showSkipped: next });
    el.skipInspectBtn.setAttribute('aria-pressed', String(next));
    el.pagesStack.classList.toggle('show-skipped', next);
  });

  // Options Popover toggle
  const setPopoverOpen = (open) => {
    el.optionsPopover.hidden = !open;
    el.voiceOptionsBtn.setAttribute('aria-expanded', String(open));
  };
  el.voiceOptionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPopoverOpen(el.optionsPopover.hidden);
  });
  el.closeOptionsBtn.addEventListener('click', () => setPopoverOpen(false));
  document.addEventListener('click', (e) => {
    if (!el.optionsPopover.hidden && !el.optionsPopover.contains(e.target) && !el.voiceOptionsBtn.contains(e.target)) {
      setPopoverOpen(false);
    }
  });

  // Voice & playback settings
  el.voiceSelect.addEventListener('change', () => {
    saveSettings({ voice: el.voiceSelect.value });
    buildPrefetchQueue();
    showToast(`Đã chọn giọng: ${el.voiceSelect.selectedOptions[0]?.textContent || el.voiceSelect.value}`);
  });

  el.speedSlider.addEventListener('input', () => {
    const speed = Number(el.speedSlider.value);
    el.speedValue.textContent = `${speed.toFixed(2)}×`;
    saveSettings({ speed });
    state.audioEl.playbackRate = speed;
  });

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.hlMode;
      saveSettings({ highlightMode: mode });
      applySettingsToUi();
      const active = state.analyzed?.sentences[state.currentSentenceIndex];
      if (active) renderSentenceHighlights(active, null, false);
    });
  });

  // Auto-skip filters live re-analysis
  const onFilterChange = () => {
    saveSettings({
      skipHeadersFooters: el.optSkipHeaders.checked,
      skipPageNumbers: el.optSkipPageNums.checked,
      skipFigures: el.optSkipFigures.checked,
      skipFootnotes: el.optSkipFootnotes.checked,
    });
    reanalyzeLayout(false);
  };
  [el.optSkipHeaders, el.optSkipPageNums, el.optSkipFigures, el.optSkipFootnotes].forEach((cb) =>
    cb.addEventListener('change', onFilterChange)
  );

  // Translation provider
  el.providerSelect.addEventListener('change', () => {
    saveSettings({ provider: el.providerSelect.value });
    el.llmConfigGroup.hidden = el.providerSelect.value !== 'openai';
    buildPrefetchQueue();
  });
  [
    [el.llmBaseUrl, 'openaiBaseUrl'],
    [el.llmModel, 'openaiModel'],
    [el.llmApiKey, 'openaiApiKey'],
  ].forEach(([input, key]) => {
    input.addEventListener('change', () => {
      saveSettings({ [key]: input.value.trim() });
      buildPrefetchQueue();
    });
  });

  // Instant Voice Cloning upload
  el.cloneUploadBtn.addEventListener('click', async () => {
    const name = el.cloneNameInput.value.trim();
    const file = el.cloneFileInput.files?.[0];
    if (!name || !file) {
      el.cloneStatus.textContent = 'Nhập tên giọng và chọn file .wav mẫu.';
      return;
    }
    el.cloneStatus.textContent = 'Đang tải giọng mẫu lên VieNeu-TTS…';
    try {
      const res = await state.api.uploadClonedVoice(name, file);
      el.cloneStatus.textContent = `Đã lưu "${res.id}" (${res.durationSec}s).`;
      await refreshVoices();
      el.voiceSelect.value = res.id;
      saveSettings({ voice: res.id });
      buildPrefetchQueue();
    } catch (err) {
      el.cloneStatus.textContent = `Lỗi: ${err.message}`;
    }
  });

  // Theme toggle
  el.themeToggleBtn.addEventListener('click', () => {
    const next = state.settings.theme === 'dusk' ? 'light' : 'dusk';
    saveSettings({ theme: next });
    applySettingsToUi();
  });

  // Backend reconnect
  el.reconnectBtn.addEventListener('click', () => {
    saveSettings({ backendUrl: el.backendUrlInput.value.trim() || DEFAULT_BACKEND_URL });
    buildPrefetchQueue();
    connectBackend();
  });

  // File picker & Drag-and-drop PDF
  const triggerFilePick = () => el.hiddenFileInput.click();
  el.openFileBtn.addEventListener('click', triggerFilePick);
  el.pickPdfBtn.addEventListener('click', triggerFilePick);

  el.hiddenFileInput.addEventListener('change', async () => {
    const file = el.hiddenFileInput.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    await loadPdfFromBytes(new Uint8Array(buf), file.name);
    el.hiddenFileInput.value = '';
  });

  el.loadDemoBtn.addEventListener('click', async () => {
    const demoBytes = buildSampleAcademicPdfBytes();
    await loadPdfFromBytes(demoBytes, 'SimCLR-Demo-2Col.pdf');
  });

  el.urlLoadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = el.pdfUrlInput.value.trim();
    if (url) await loadPdfFromUrl(url);
  });

  // Global drag & drop support
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.dropZone.classList.add('is-dragover');
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) el.dropZone.classList.remove('is-dragover');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.dropZone.classList.remove('is-dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
      const buf = await file.arrayBuffer();
      await loadPdfFromBytes(new Uint8Array(buf), file.name);
    }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      jumpAndPlay(state.currentSentenceIndex + 1);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      jumpAndPlay(state.currentSentenceIndex - 1);
    } else if (e.key === 'f' || e.key === 'F') {
      el.focusDimBtn.click();
    } else if (e.key === 'c' || e.key === 'C') {
      el.subtitleToggleBtn.click();
    } else if (e.key === 's' || e.key === 'S') {
      el.skipInspectBtn.click();
    } else if (e.key === 'Escape') {
      setPopoverOpen(false);
    }
  });
}

// ============================================================================
// Bootstrap
// ============================================================================
async function bootstrap() {
  state.settings = await loadSettings();
  applySettingsToUi();
  bindEvents();
  buildPrefetchQueue();
  connectBackend();

  const params = new URLSearchParams(window.location.search);
  const src = params.get('src');
  if (src) {
    await loadPdfFromUrl(src);
  } else if (params.get('demo') === '1') {
    const demoBytes = buildSampleAcademicPdfBytes();
    await loadPdfFromBytes(demoBytes, 'SimCLR-Demo-2Col.pdf');
  }
}

bootstrap();
