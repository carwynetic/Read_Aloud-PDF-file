// src/background/service-worker.js
function isLikelyPdfUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("chrome-extension://") || url.startsWith("edge-extension://")) return false;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (path.endsWith(".pdf")) return true;
    if (u.hostname.includes("arxiv.org") && path.startsWith("/pdf/")) return true;
    if (u.hostname.includes("openreview.net") && path.startsWith("/pdf")) return true;
    if (u.hostname.includes("aclanthology.org") && path.endsWith(".pdf")) return true;
    return false;
  } catch {
    return false;
  }
}
function buildViewerUrl(pdfUrl) {
  const base = chrome.runtime.getURL("viewer.html");
  return pdfUrl ? `${base}?src=${encodeURIComponent(pdfUrl)}` : base;
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "open-pdf-in-vieneu",
      title: "\u0110\u1ECDc PDF n\xE0y b\u1EB1ng VieNeu Read Aloud VI",
      contexts: ["page", "link"]
    });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "open-pdf-in-vieneu") return;
  const targetUrl = info.linkUrl || info.pageUrl || tab?.url || "";
  chrome.tabs.create({ url: buildViewerUrl(targetUrl) });
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" || !changeInfo.url) return;
  if (!isLikelyPdfUrl(changeInfo.url)) return;
  try {
    const { autoInterceptPdf } = await chrome.storage.local.get({ autoInterceptPdf: false });
    if (autoInterceptPdf) {
      chrome.tabs.update(tabId, { url: buildViewerUrl(changeInfo.url) });
    }
  } catch {
  }
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "OPEN_VIEWER") {
    chrome.tabs.create({ url: buildViewerUrl(msg.pdfUrl || "") });
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "FETCH_PDF_ARRAYBUFFER" && msg.url) {
    fetch(msg.url).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    }).then((buf) => {
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 32768;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      sendResponse({ ok: true, base64: btoa(binary) });
    }).catch((err) => {
      sendResponse({ ok: false, error: err?.message || String(err) });
    });
    return true;
  }
  return false;
});
