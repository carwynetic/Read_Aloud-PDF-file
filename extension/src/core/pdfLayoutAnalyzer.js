/**
 * Smart PDF Layout Analyzer & Non-Body Region Filter
 *
 * Reconstructs natural reading order (including 2-column academic papers),
 * automatically skips running headers, footers, page numbers, footnotes,
 * figure/diagram interior labels, and figure/table captions, and emits
 * normalized (0..1) bounding boxes for paragraphs, sentences, and words.
 */

const PAGE_NUMBER_RE =
  /^(?:[-–—•·]?\s*)?(?:page\s*)?(?:\d{1,4}|[ivxlcdm]{1,6})(?:\s*(?:of|\/)\s*\d{1,4})?(?:\s*[-–—•·])?$/i;

const CAPTION_START_RE =
  /^(?:figure|fig\.?|table|tbl\.?|algorithm|alg\.?|scheme|chart|plate)\s*\d+[a-z]?(?:\s*[:.\-–—]|\s+[A-Z])/i;

const FIGURE_CAPTION_START_RE =
  /^(?:figure|fig\.?|scheme|chart|plate)\s*\d+[a-z]?(?:\s*[:.\-–—]|\s+[A-Z])/i;

const EMAIL_RE = /<?[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}>?/i;

const FOOTER_METADATA_RE =
  /(?:proceedings\s+of\s+the|copyright\s+(?:©|\(c\))?\s*\d{4}|all\s+rights\s+reserved|correspondence\s+to\s*:|code\s+available\s+at|preprint\.?\s*under\s+review|published\s+as\s+a\s+conference\s+paper|arxiv:\d{4}\.\d{4,5}|https?:\/\/|github\.com\/|\bpmlr\s+\d+|\bthe\s+author\(s\)|equal\s+contribution|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

const FOOTNOTE_PREFIX_RE = /^(?:[\d*†‡§¶]{1,2}\s*[A-Z][a-z]+|<?[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}>?)/i;

function normalizePdfString(raw) {
  return String(raw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u00ad/g, '')
    .replace(/\ufb00/g, 'ff')
    .replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl')
    .replace(/\ufb03/g, 'ffi')
    .replace(/\ufb04/g, 'ffl')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'et',
  'al.',
  'fig.',
  'figs.',
  'eq.',
  'eqs.',
  'sec.',
  'secs.',
  'tab.',
  'dr.',
  'mr.',
  'mrs.',
  'ms.',
  'prof.',
  'vs.',
  'no.',
  'vol.',
  'pp.',
  'p.',
  'inc.',
  'ltd.',
  'st.',
  'cf.',
  'approx.',
  'ref.',
  'refs.',
  'ch.',
  'art.',
]);

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function normalizeHeaderKey(text) {
  return (text || '')
    .trim()
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ');
}

function median(values) {
  if (!values.length) return 11;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function rectsOverlap(a, b, pad = 2) {
  const ax1 = a.x - pad;
  const ay1 = a.y - pad;
  const ax2 = a.x + a.width + pad;
  const ay2 = a.y + a.height + pad;
  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
}

function intersectionRatio(itemRect, figBox) {
  const x1 = Math.max(itemRect.x, figBox.x);
  const y1 = Math.max(itemRect.y, figBox.y);
  const x2 = Math.min(itemRect.x + itemRect.width, figBox.x + figBox.width);
  const y2 = Math.min(itemRect.y + itemRect.height, figBox.y + figBox.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const area = Math.max(1, itemRect.width * itemRect.height);
  return inter / area;
}

/**
 * Group raw text items into visual lines (items sharing a baseline within column).
 */
function buildVisualLines(items, pageWidth, pageHeight) {
  const rotatedItems = [];
  const valid = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string') continue;
    const cleanStr = normalizePdfString(it.str);
    if (!cleanStr) continue;
    const normalized = {
      str: cleanStr,
      x: Number(it.x) || 0,
      y: Number(it.y) || 0,
      width: Math.max(1, Number(it.width) || 1),
      height: Math.max(4, Number(it.height) || 10),
      rotated: Boolean(it.rotated),
    };
    if (normalized.rotated) {
      rotatedItems.push(normalized);
    } else {
      valid.push(normalized);
    }
  }

  if (!valid.length) return { lines: [], isTwoColumn: false, rotatedItems };

  // Sort primarily by y, secondarily by x
  valid.sort((a, b) => (Math.abs(a.y - b.y) <= 3 ? a.x - b.x : a.y - b.y));

  // Detect if page has a clear 2-column vertical gutter around the center
  const midX = pageWidth * 0.5;
  const leftCount = valid.filter((it) => it.x + it.width < midX + pageWidth * 0.02).length;
  const rightCount = valid.filter((it) => it.x > midX - pageWidth * 0.02).length;
  const crossingCenter = valid.filter(
    (it) => it.x < midX - pageWidth * 0.04 && it.x + it.width > midX + pageWidth * 0.04 && it.width > pageWidth * 0.35
  );
  const isTwoColumn = leftCount >= 3 && rightCount >= 3 && crossingCenter.length < valid.length * 0.45;

  // Group into lines without merging across the center column gutter
  const lines = [];
  for (const it of valid) {
    const col = isTwoColumn
      ? it.x + it.width < midX + pageWidth * 0.02
        ? 'left'
        : it.x > midX - pageWidth * 0.02
          ? 'right'
          : 'full'
      : 'full';

    let target = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = lines[i];
      if (candidate.col !== col) continue;
      const yTol = Math.max(4, Math.min(candidate.height, it.height) * 0.55);
      if (Math.abs(candidate.y - it.y) <= yTol) {
        // Don't merge wildly separated horizontal chunks (e.g. diagram labels)
        const gap = it.x - (candidate.x + candidate.width);
        if (gap < Math.max(36, candidate.height * 4.5)) {
          target = candidate;
          break;
        }
      }
    }

    if (target) {
      target.items.push(it);
      const minX = Math.min(target.x, it.x);
      const maxX = Math.max(target.x + target.width, it.x + it.width);
      const minY = Math.min(target.y, it.y);
      const maxY = Math.max(target.y + target.height, it.y + it.height);
      target.x = minX;
      target.y = minY;
      target.width = maxX - minX;
      target.height = maxY - minY;
    } else {
      lines.push({
        col,
        x: it.x,
        y: it.y,
        width: it.width,
        height: it.height,
        items: [it],
        pageWidth,
        pageHeight,
      });
    }
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    // Merge kerning-split adjacent PDF.js items (gap <= ~0.14 * fontHeight) without bogus spaces
    const mergedItems = [];
    for (const it of line.items) {
      const prev = mergedItems[mergedItems.length - 1];
      if (prev) {
        const gap = it.x - (prev.x + prev.width);
        const kernThreshold = Math.max(1.2, Math.min(prev.height, it.height) * 0.14);
        if (gap <= kernThreshold) {
          prev.str = prev.str + it.str;
          prev.width = Math.max(prev.x + prev.width, it.x + it.width) - prev.x;
          prev.y = Math.min(prev.y, it.y);
          prev.height = Math.max(prev.height, it.height);
          continue;
        }
      }
      mergedItems.push({ ...it });
    }
    line.items = mergedItems;
    line.text = line.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    line.fontSize = median(line.items.map((it) => it.height));
  }

  return { lines, isTwoColumn, rotatedItems };
}

/**
 * Split a visual line into per-word normalized bounding boxes.
 */
function lineToWordBoxes(line, pageNumber) {
  const words = [];
  const pw = Math.max(1, line.pageWidth);
  const ph = Math.max(1, line.pageHeight);

  for (const it of line.items) {
    const rawTokens = it.str.split(/\s+/).filter(Boolean);
    if (!rawTokens.length) continue;

    const totalChars = rawTokens.reduce((sum, tok) => sum + tok.length, 0) + Math.max(0, rawTokens.length - 1);
    const charW = it.width / Math.max(1, totalChars);
    let cursorX = it.x;

    for (let i = 0; i < rawTokens.length; i++) {
      const tok = rawTokens[i];
      const tokW = Math.max(2, tok.length * charW);
      words.push({
        word: tok,
        pageNumber,
        x: clamp01(cursorX / pw),
        y: clamp01(it.y / ph),
        width: clamp01(tokW / pw),
        height: clamp01(it.height / ph),
      });
      cursorX += tokW + charW;
    }
  }
  return words;
}

/**
 * Order lines on a page: full-width top blocks -> left column -> right column -> full-width bottom blocks.
 */
function sortLinesInReadingOrder(lines, isTwoColumn) {
  if (!isTwoColumn) {
    return [...lines].sort((a, b) => (Math.abs(a.y - b.y) <= 3 ? a.x - b.x : a.y - b.y));
  }

  const colLines = lines.filter((l) => l.col === 'left' || l.col === 'right');
  const firstColY = colLines.length ? Math.min(...colLines.map((l) => l.y)) : Infinity;

  const fullTop = lines
    .filter((l) => l.col === 'full' && l.y <= firstColY)
    .sort((a, b) => a.y - b.y);
  const left = lines.filter((l) => l.col === 'left').sort((a, b) => a.y - b.y);
  const right = lines.filter((l) => l.col === 'right').sort((a, b) => a.y - b.y);
  const fullBottom = lines
    .filter((l) => l.col === 'full' && l.y > firstColY)
    .sort((a, b) => a.y - b.y);

  return [...fullTop, ...left, ...right, ...fullBottom];
}

/**
 * Group ordered body lines into paragraphs based on column change and vertical gap.
 */
function groupLinesIntoParagraphs(lines, bodyFontSize, pageNumber) {
  const paragraphs = [];
  let current = null;

  for (const line of lines) {
    if (!current) {
      current = { pageNumber, col: line.col, lines: [line] };
      continue;
    }
    const prev = current.lines[current.lines.length - 1];
    const vGap = line.y - (prev.y + prev.height);
    const sameColumn = line.col === prev.col;
    const isLargeGap = vGap > Math.max(bodyFontSize * 0.95, prev.height * 0.95);
    const isHeadingBreak =
      Math.abs(line.fontSize - prev.fontSize) > bodyFontSize * 0.28 ||
      /^(?:\d+(?:\.\d+)*\s+[A-Z]|abstract|introduction|related\s+work|method|experiments|conclusion|references)\b/i.test(
        line.text
      );

    if (!sameColumn || isLargeGap || isHeadingBreak) {
      paragraphs.push(current);
      current = { pageNumber, col: line.col, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

/**
 * Compute union bounding rectangles per line (in normalized 0..1 coordinates).
 */
function mergeWordRectsByLine(words) {
  if (!words.length) return [];
  const rows = [];
  for (const w of words) {
    const last = rows[rows.length - 1];
    if (
      last &&
      last.pageNumber === w.pageNumber &&
      Math.abs(last.y - w.y) <= Math.max(0.008, Math.min(last.height, w.height) * 0.75) &&
      w.x >= last.x - 0.02
    ) {
      const x1 = Math.min(last.x, w.x);
      const y1 = Math.min(last.y, w.y);
      const x2 = Math.max(last.x + last.width, w.x + w.width);
      const y2 = Math.max(last.y + last.height, w.y + w.height);
      last.x = x1;
      last.y = y1;
      last.width = x2 - x1;
      last.height = y2 - y1;
    } else {
      rows.push({
        pageNumber: w.pageNumber,
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height,
      });
    }
  }
  return rows;
}

function isSentenceTerminator(wordToken, nextWordToken) {
  if (!wordToken) return false;
  const cleaned = wordToken.replace(/["'”’)\]]+$/g, '');
  if (!/[.!?…]$/.test(cleaned)) return false;

  const lower = cleaned.toLowerCase();
  if (ABBREVIATIONS.has(lower)) return false;
  // Single capital initial like "A." or "J."
  if (/^[A-Z]\.$/.test(cleaned)) return false;
  // Decimal number or section number like "3.1" or "1."
  if (/^\d+\.$/.test(cleaned) && nextWordToken && /^[a-z0-9]/.test(nextWordToken)) return false;
  // If next word starts lowercase, likely an abbreviation rather than sentence end
  if (nextWordToken && /^[a-z]/.test(nextWordToken)) return false;

  return true;
}

/**
 * Join PDF line-wrap hyphenated words ("dis-" at end of line + "criminative" at start of next line)
 * while retaining their visual bounding boxes for highlighting.
 */
function buildParagraphWordStream(paragraph) {
  const stream = [];
  for (let li = 0; li < paragraph.lines.length; li++) {
    const lineWords = lineToWordBoxes(paragraph.lines[li], paragraph.pageNumber);
    for (let wi = 0; wi < lineWords.length; wi++) {
      const w = lineWords[wi];
      const prev = stream[stream.length - 1];
      if (
        wi === 0 &&
        prev &&
        prev.isLineEndHyphen &&
        /^[a-z]{2,}/.test(w.word)
      ) {
        prev.joinedText = prev.word.slice(0, -1) + w.word;
        prev.continuationBox = w;
        prev.isLineEndHyphen = false;
        continue;
      }
      const isLineEndHyphen =
        wi === lineWords.length - 1 &&
        li < paragraph.lines.length - 1 &&
        /[A-Za-z]{2,}-$/.test(w.word);
      stream.push({ ...w, isLineEndHyphen });
    }
  }
  return stream;
}

/**
 * Main document analyzer entry point.
 *
 * @param {Array<{pageNumber: number, width: number, height: number, items: Array, figureBoxes?: Array}>} pages
 * @param {Object} options
 */
export function analyzeDocumentPages(pages, options = {}) {
  const {
    skipHeadersFooters = true,
    skipPageNumbers = true,
    skipFigures = true,
    skipFootnotes = true,
  } = options;

  const pageSummaries = pages.map((p) => {
    const { lines, isTwoColumn, rotatedItems } = buildVisualLines(
      p.items || [],
      p.width || 600,
      p.height || 800
    );
    return {
      pageNumber: p.pageNumber,
      width: p.width || 600,
      height: p.height || 800,
      figureBoxes: p.figureBoxes || [],
      lines: lines || [],
      rotatedItems: rotatedItems || [],
      isTwoColumn: Boolean(isTwoColumn),
    };
  });

  // Estimate dominant body font size from substantial lines (>= 25 chars)
  // so dozens of tiny chart/diagram labels cannot skew the body font size downward
  const proseSizedLines = pageSummaries.flatMap((ps) =>
    ps.lines.filter((l) => (l.text || '').length >= 25).map((l) => l.fontSize)
  );
  const allFontSizes = proseSizedLines.length
    ? proseSizedLines
    : pageSummaries.flatMap((ps) => ps.lines.map((l) => l.fontSize));
  const bodyFontSize = median(allFontSizes);

  // Detect repeated running headers & footers across pages (>= 2 pages)
  // Exclude large display titles (fontSize > bodyFontSize * 1.18) from header counting
  const topRepeatCounts = new Map();
  const bottomRepeatCounts = new Map();
  if (pageSummaries.length >= 2) {
    for (const ps of pageSummaries) {
      const seenTop = new Set();
      const seenBottom = new Set();
      for (const line of ps.lines) {
        const yRatio = line.y / ps.height;
        const key = normalizeHeaderKey(line.text);
        if (!key || key.length < 3) continue;
        if (yRatio < 0.12 && line.fontSize <= bodyFontSize * 1.18 && !seenTop.has(key)) {
          seenTop.add(key);
          topRepeatCounts.set(key, (topRepeatCounts.get(key) || 0) + 1);
        } else if (yRatio > 0.88 && !seenBottom.has(key)) {
          seenBottom.add(key);
          bottomRepeatCounts.set(key, (bottomRepeatCounts.get(key) || 0) + 1);
        }
      }
    }
  }

  const isProseBodyLine = (line, ps) => {
    const colWidth = ps.isTwoColumn && line.col !== 'full' ? ps.width * 0.43 : ps.width * 0.78;
    const words = line.text.split(/\s+/).filter(Boolean);
    const hasLowercaseProse = /[a-z]{3,}/.test(line.text);
    const looksLikeFullSentence =
      words.length >= 6 &&
      /[.!?]$/.test(line.text) &&
      line.fontSize >= bodyFontSize * 0.95 &&
      hasLowercaseProse;
    return (
      !CAPTION_START_RE.test(line.text) &&
      (looksLikeFullSentence ||
        (line.width >= colWidth * 0.68 &&
          words.length >= 7 &&
          line.fontSize >= bodyFontSize * 0.90 &&
          hasLowercaseProse))
    );
  };

  const skippedRegions = [];
  const paragraphs = [];
  const sentences = [];
  let paragraphSeq = 0;
  let sentenceSeq = 0;

  for (const ps of pageSummaries) {
    // Record skipped rotated margin watermarks (e.g. vertical arXiv stamps & y-axis labels)
    if (skipHeadersFooters && ps.rotatedItems.length > 0) {
      for (const rot of ps.rotatedItems) {
        skippedRegions.push({
          id: `skip-${ps.pageNumber}-${skippedRegions.length}`,
          pageNumber: ps.pageNumber,
          reason: 'watermark',
          text: rot.str,
          rect: {
            x: clamp01(rot.x / ps.width),
            y: clamp01(rot.y / ps.height),
            width: clamp01(rot.width / ps.width),
            height: clamp01(rot.height / ps.height),
          },
        });
      }
    }

    const ordered = sortLinesInReadingOrder(ps.lines, ps.isTwoColumn);
    const skipReasonByIdx = new Array(ordered.length).fill(null);

    // Pre-pass A: Mark Figure/Table captions & upward non-prose figure/chart zones above Figure captions
    if (skipFigures) {
      let activeCapCol = null;
      let activeCapBottomY = -1;
      let activeCapFontSize = bodyFontSize;
      const figureCaptionIndices = [];

      for (let i = 0; i < ordered.length; i++) {
        const line = ordered[i];
        if (CAPTION_START_RE.test(line.text)) {
          skipReasonByIdx[i] = 'caption';
          activeCapCol = line.col;
          activeCapBottomY = line.y + line.height;
          activeCapFontSize = line.fontSize;
          if (FIGURE_CAPTION_START_RE.test(line.text)) {
            figureCaptionIndices.push(i);
          }
          continue;
        }
        if (
          activeCapCol === line.col &&
          line.y - activeCapBottomY <= Math.max(line.height * 0.95, activeCapFontSize * 0.95) &&
          line.fontSize <= Math.max(activeCapFontSize * 1.06, bodyFontSize * 0.98)
        ) {
          skipReasonByIdx[i] = 'caption';
          activeCapBottomY = line.y + line.height;
          continue;
        }
        activeCapCol = null;
      }

      // Walk upward from each Figure N caption in the same horizontal band to skip chart/diagram labels above it
      for (const capIdx of figureCaptionIndices) {
        const capLine = ordered[capIdx];
        const capX1 = capLine.x - 28;
        const capX2 = capLine.x + capLine.width + 28;
        let prevY = capLine.y;
        for (let j = capIdx - 1; j >= 0; j--) {
          const cand = ordered[j];
          if (cand.col !== capLine.col && capLine.col !== 'full') break;
          // Must horizontally overlap the caption's column/figure span (never cross into another column)
          const candX2 = cand.x + cand.width;
          if (candX2 < capX1 || cand.x > capX2) continue;
          // Stop if this is real body prose
          if (isProseBodyLine(cand, ps)) break;
          // Do not consume large Page 1 title or section headings above the figure
          if (cand.fontSize > bodyFontSize * 1.18) break;
          if (/^(?:\d+(?:\.\d+)*\s+[A-Z]|abstract|introduction)\b/i.test(cand.text)) break;
          // Stop if far above the chart block
          if (prevY - (cand.y + cand.height) > ps.height * 0.22) break;
          skipReasonByIdx[j] = 'figure';
          prevY = cand.y;
        }
      }
    }

    // Main pass: classify headers, footers, page numbers, footnotes, vector figure interiors
    const bodyLines = [];
    const footerActiveInCol = new Set();

    for (let i = 0; i < ordered.length; i++) {
      const line = ordered[i];
      const yRatio = line.y / ps.height;
      const bottomRatio = (line.y + line.height) / ps.height;
      const centerXRatio = (line.x + line.width / 2) / ps.width;
      const normKey = normalizeHeaderKey(line.text);
      const normRect = {
        x: clamp01(line.x / ps.width),
        y: clamp01(line.y / ps.height),
        width: clamp01(line.width / ps.width),
        height: clamp01(line.height / ps.height),
      };

      const recordSkip = (reason) => {
        skippedRegions.push({
          id: `skip-${ps.pageNumber}-${skippedRegions.length}`,
          pageNumber: ps.pageNumber,
          reason,
          text: line.text,
          rect: normRect,
        });
      };

      // 0. Already marked as caption or caption-anchored figure label
      if (skipReasonByIdx[i]) {
        recordSkip(skipReasonByIdx[i]);
        continue;
      }

      // 1. Standalone page number (avoid false positive on single math letter like 'i' inside a top diagram)
      if (
        skipPageNumbers &&
        PAGE_NUMBER_RE.test(line.text) &&
        (yRatio < 0.085 || bottomRatio > 0.88) &&
        (!/^[ivx]$/i.test(line.text.trim()) ||
          bottomRatio > 0.91 ||
          Math.abs(centerXRatio - 0.5) < 0.14)
      ) {
        recordSkip('page-number');
        continue;
      }

      // 2. Running header (never skip large Page 1 display titles!)
      if (
        skipHeadersFooters &&
        line.fontSize <= bodyFontSize * 1.18 &&
        (yRatio < 0.068 || (yRatio < 0.12 && (topRepeatCounts.get(normKey) || 0) >= 2))
      ) {
        recordSkip('header');
        continue;
      }

      // 3. Running footer / conference copyright / bottom emails / continuation lines of an active footer block
      if (
        skipHeadersFooters &&
        (bottomRatio > 0.945 ||
          (bottomRatio > 0.88 && (bottomRepeatCounts.get(normKey) || 0) >= 2) ||
          (bottomRatio > 0.70 && FOOTER_METADATA_RE.test(line.text)) ||
          (bottomRatio > 0.72 &&
            footerActiveInCol.has(line.col) &&
            line.fontSize <= bodyFontSize * 0.96))
      ) {
        if (bottomRatio > 0.70 && line.fontSize <= bodyFontSize * 0.96) {
          footerActiveInCol.add(line.col);
        }
        recordSkip('footer');
        continue;
      }

      // 4. Footnotes near page bottom (smaller font size, superscript/email prefix, or continuation)
      if (
        skipFootnotes &&
        bottomRatio > 0.72 &&
        line.fontSize <= bodyFontSize * 0.90 &&
        (FOOTNOTE_PREFIX_RE.test(line.text) ||
          EMAIL_RE.test(line.text) ||
          FOOTER_METADATA_RE.test(line.text))
      ) {
        footerActiveInCol.add(line.col);
        recordSkip('footnote');
        continue;
      }

      // 5. Text inside raster or vector figure / diagram graphic bounding boxes
      if (skipFigures && ps.figureBoxes.length > 0) {
        const insideFigure = ps.figureBoxes.some(
          (fig) => intersectionRatio(line, fig) >= 0.35 || rectsOverlap(line, fig, 2)
        );
        if (insideFigure) {
          recordSkip('figure');
          continue;
        }
      }

      // 6. Skip isolated tiny subscript/superscript noise lines (e.g. standalone "i j", "k", "1")
      if (
        line.fontSize < bodyFontSize * 0.74 &&
        line.text.length <= 8 &&
        !/[a-z]{3,}/i.test(line.text)
      ) {
        continue;
      }

      bodyLines.push(line);
    }

    const pageParagraphs = groupLinesIntoParagraphs(bodyLines, bodyFontSize, ps.pageNumber);

    for (const para of pageParagraphs) {
      const wordStream = buildParagraphWordStream(para);
      if (!wordStream.length) continue;

      const paragraphId = `p-${paragraphSeq++}`;
      const paraWordsFlat = [];
      for (const entry of wordStream) {
        paraWordsFlat.push(entry);
        if (entry.continuationBox) paraWordsFlat.push(entry.continuationBox);
      }

      const paraRects = mergeWordRectsByLine(paraWordsFlat);
      const paraSentenceIds = [];

      // Split wordStream into sentences
      let currentTokens = [];
      const flushSentence = () => {
        if (!currentTokens.length) return;
        const text = currentTokens
          .map((t) => t.joinedText || t.word)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text) {
          currentTokens = [];
          return;
        }

        const sentenceWords = [];
        for (const t of currentTokens) {
          sentenceWords.push({
            word: t.joinedText || t.word,
            pageNumber: t.pageNumber,
            x: t.x,
            y: t.y,
            width: t.width,
            height: t.height,
          });
          if (t.continuationBox) {
            sentenceWords.push({
              word: t.continuationBox.word,
              pageNumber: t.continuationBox.pageNumber,
              x: t.continuationBox.x,
              y: t.continuationBox.y,
              width: t.continuationBox.width,
              height: t.continuationBox.height,
            });
          }
        }

        const sid = `s-${sentenceSeq++}`;
        paraSentenceIds.push(sid);
        sentences.push({
          id: sid,
          index: sentences.length,
          paragraphId,
          pageNumber: ps.pageNumber,
          text,
          rects: mergeWordRectsByLine(sentenceWords),
          words: sentenceWords,
        });
        currentTokens = [];
      };

      for (let i = 0; i < wordStream.length; i++) {
        const cur = wordStream[i];
        const next = wordStream[i + 1];
        currentTokens.push(cur);
        const displayToken = cur.joinedText || cur.word;
        const nextDisplay = next ? next.joinedText || next.word : null;
        if (isSentenceTerminator(displayToken, nextDisplay)) {
          flushSentence();
        }
      }
      flushSentence();

      if (paraSentenceIds.length > 0) {
        paragraphs.push({
          id: paragraphId,
          pageNumber: ps.pageNumber,
          rects: paraRects,
          sentenceIds: paraSentenceIds,
        });
      }
    }
  }

  return {
    paragraphs,
    sentences,
    skippedRegions,
    stats: {
      totalPages: pageSummaries.length,
      totalParagraphs: paragraphs.length,
      totalSentences: sentences.length,
      totalSkipped: skippedRegions.length,
    },
  };
}

/**
 * Merge nearby bounding boxes within `gap` pixels into cohesive clusters.
 */
function clusterBoxes(rawBoxes, gap = 22) {
  if (!rawBoxes.length) return [];
  const clusters = rawBoxes.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (rectsOverlap(clusters[i], clusters[j], gap)) {
          const a = clusters[i];
          const b = clusters[j];
          const x1 = Math.min(a.x, b.x);
          const y1 = Math.min(a.y, b.y);
          const x2 = Math.max(a.x + a.width, b.x + b.width);
          const y2 = Math.max(a.y + a.height, b.y + b.height);
          clusters[i] = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
          clusters.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }
  return clusters;
}

/**
 * Extract raster image AND vector figure/chart bounding boxes from a PDF.js
 * page's operator list in top-down viewport coordinates so diagram/plot labels
 * (axes, legends, TikZ nodes, arrows) are automatically skipped.
 */
export async function extractFigureBoxesFromPdfPage(pdfPage, viewport, OPS) {
  if (!pdfPage || !viewport || !OPS) return [];
  const imageBoxes = [];
  const vectorPrims = [];
  const pageArea = Math.max(1, viewport.width * viewport.height);

  try {
    const opList = await pdfPage.getOperatorList();
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];

    const multiply = (m1, m2) => [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];

    const transformPoint = (m, x, y) => [
      m[0] * x + m[2] * y + m[4],
      m[1] * x + m[3] * y + m[5],
    ];

    const pointsToViewportBox = (pts) => {
      if (!pts.length) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [px, py] of pts) {
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        const [vx, vy] = viewport.convertToViewportPoint(px, py);
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) continue;
        if (vx < minX) minX = vx;
        if (vy < minY) minY = vy;
        if (vx > maxX) maxX = vx;
        if (vy > maxY) maxY = vy;
      }
      if (!Number.isFinite(minX)) return null;
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    };

    const recordVectorBox = (box) => {
      if (!box) return;
      const { width, height } = box;
      // Ignore full-page frames/clipping rectangles
      if (width * height > pageArea * 0.72) return;
      // Ignore thin horizontal divider rules (header/footer/footnote rules)
      if (height < 6 && width > viewport.width * 0.14) return;
      // Ignore thin vertical column rules
      if (width < 6 && height > viewport.height * 0.55) return;
      // Ignore microscopic dots/text underlines
      if (width < 3 && height < 3) return;
      vectorPrims.push(box);
    };

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];

      if (fn === OPS.save) {
        stack.push([...ctm]);
      } else if (fn === OPS.restore) {
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.transform && Array.isArray(args) && args.length === 6) {
        ctm = multiply(ctm, args);
      } else if (
        OPS.paintFormXObjectBegin &&
        fn === OPS.paintFormXObjectBegin &&
        Array.isArray(args)
      ) {
        stack.push([...ctm]);
        if (Array.isArray(args[0]) && args[0].length === 6) {
          ctm = multiply(ctm, args[0]);
        }
      } else if (OPS.paintFormXObjectEnd && fn === OPS.paintFormXObjectEnd) {
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      } else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintImageMaskXObject
      ) {
        const pts = [
          transformPoint(ctm, 0, 0),
          transformPoint(ctm, 1, 0),
          transformPoint(ctm, 0, 1),
          transformPoint(ctm, 1, 1),
        ];
        const box = pointsToViewportBox(pts);
        if (box && box.width >= 40 && box.height >= 40 && box.width * box.height < pageArea * 0.72) {
          imageBoxes.push(box);
        }
      } else if (OPS.constructPath && fn === OPS.constructPath && Array.isArray(args)) {
        const subOps = args[0] || [];
        const coords = args[1] || [];
        const minMax = args[2];
        const pts = [];

        if (Array.isArray(minMax) && minMax.length === 4 && Number.isFinite(minMax[0])) {
          pts.push(
            transformPoint(ctm, minMax[0], minMax[1]),
            transformPoint(ctm, minMax[2], minMax[1]),
            transformPoint(ctm, minMax[0], minMax[3]),
            transformPoint(ctm, minMax[2], minMax[3])
          );
        } else {
          let ci = 0;
          for (let k = 0; k < subOps.length; k++) {
            const op = subOps[k];
            if (op === OPS.moveTo || op === OPS.lineTo) {
              pts.push(transformPoint(ctm, coords[ci], coords[ci + 1]));
              ci += 2;
            } else if (op === OPS.curveTo) {
              pts.push(
                transformPoint(ctm, coords[ci], coords[ci + 1]),
                transformPoint(ctm, coords[ci + 2], coords[ci + 3]),
                transformPoint(ctm, coords[ci + 4], coords[ci + 5])
              );
              ci += 6;
            } else if (
              (OPS.curveTo2 && op === OPS.curveTo2) ||
              (OPS.curveTo3 && op === OPS.curveTo3)
            ) {
              pts.push(
                transformPoint(ctm, coords[ci], coords[ci + 1]),
                transformPoint(ctm, coords[ci + 2], coords[ci + 3])
              );
              ci += 4;
            } else if (op === OPS.rectangle) {
              const rx = coords[ci];
              const ry = coords[ci + 1];
              const rw = coords[ci + 2];
              const rh = coords[ci + 3];
              pts.push(
                transformPoint(ctm, rx, ry),
                transformPoint(ctm, rx + rw, ry),
                transformPoint(ctm, rx, ry + rh),
                transformPoint(ctm, rx + rw, ry + rh)
              );
              ci += 4;
            }
          }
        }
        recordVectorBox(pointsToViewportBox(pts));
      } else if (OPS.rectangle && fn === OPS.rectangle && Array.isArray(args) && args.length >= 4) {
        const [rx, ry, rw, rh] = args;
        const pts = [
          transformPoint(ctm, rx, ry),
          transformPoint(ctm, rx + rw, ry),
          transformPoint(ctm, rx, ry + rh),
          transformPoint(ctm, rx + rw, ry + rh),
        ];
        recordVectorBox(pointsToViewportBox(pts));
      }
    }
  } catch {
    return imageBoxes;
  }

  // Cluster vector graphic primitives into figure/chart regions (padded gently for axis/node labels)
  const vectorClusters = clusterBoxes(vectorPrims, 24)
    .filter((b) => b.width >= 55 && b.height >= 45 && b.width * b.height < pageArea * 0.72)
    .map((b) => ({
      x: Math.max(0, b.x - 14),
      y: Math.max(0, b.y - 16),
      width: Math.min(viewport.width, b.width + 28),
      height: Math.min(viewport.height, b.height + 34),
    }));

  return clusterBoxes([...imageBoxes, ...vectorClusters], 12);
}
