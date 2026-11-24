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

const FOOTER_METADATA_RE =
  /(?:proceedings\s+of\s+the|copyright\s+(?:©|\(c\))?\s*\d{4}|all\s+rights\s+reserved|correspondence\s+to\s*:|code\s+available\s+at|preprint\.?\s*under\s+review|published\s+as\s+a\s+conference\s+paper|arxiv:\d{4}\.\d{4,5}|https?:\/\/github\.com\/)/i;

const FOOTNOTE_PREFIX_RE = /^(?:[\d*†‡§¶]{1,2}\s*[A-Z][a-z]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

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
    if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
    const normalized = {
      str: it.str.replace(/\s+/g, ' ').trim(),
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

  // Estimate dominant body font size across document
  const allFontSizes = pageSummaries.flatMap((ps) => ps.lines.map((l) => l.fontSize));
  const bodyFontSize = median(allFontSizes);

  // Detect repeated running headers & footers across pages (>= 2 pages)
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
        if (yRatio < 0.12 && !seenTop.has(key)) {
          seenTop.add(key);
          topRepeatCounts.set(key, (topRepeatCounts.get(key) || 0) + 1);
        } else if (yRatio > 0.88 && !seenBottom.has(key)) {
          seenBottom.add(key);
          bottomRepeatCounts.set(key, (bottomRepeatCounts.get(key) || 0) + 1);
        }
      }
    }
  }

  const skippedRegions = [];
  const paragraphs = [];
  const sentences = [];
  let paragraphSeq = 0;
  let sentenceSeq = 0;

  for (const ps of pageSummaries) {
    // Record skipped rotated margin watermarks (e.g. vertical arXiv stamps)
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
    const bodyLines = [];
    let activeCaptionCol = null;
    let activeCaptionBottomY = -1;

    for (const line of ordered) {
      const yRatio = line.y / ps.height;
      const bottomRatio = (line.y + line.height) / ps.height;
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

      // 1. Standalone page number
      if (
        skipPageNumbers &&
        PAGE_NUMBER_RE.test(line.text) &&
        (yRatio < 0.1 || bottomRatio > 0.88)
      ) {
        recordSkip('page-number');
        continue;
      }

      // 2. Running header
      if (
        skipHeadersFooters &&
        (yRatio < 0.068 || (yRatio < 0.12 && (topRepeatCounts.get(normKey) || 0) >= 2))
      ) {
        recordSkip('header');
        continue;
      }

      // 3. Running footer / conference copyright / bottom margin
      if (
        skipHeadersFooters &&
        (bottomRatio > 0.945 ||
          (bottomRatio > 0.88 && (bottomRepeatCounts.get(normKey) || 0) >= 2) ||
          (bottomRatio > 0.78 && FOOTER_METADATA_RE.test(line.text)))
      ) {
        recordSkip('footer');
        continue;
      }

      // 4. Footnotes near page bottom (smaller font size or footnote prefix)
      if (
        skipFootnotes &&
        bottomRatio > 0.78 &&
        line.fontSize <= bodyFontSize * 0.88 &&
        (FOOTNOTE_PREFIX_RE.test(line.text) || FOOTER_METADATA_RE.test(line.text))
      ) {
        recordSkip('footnote');
        continue;
      }

      // 5. Text inside figure / diagram graphic bounding boxes
      if (skipFigures && ps.figureBoxes.length > 0) {
        const insideFigure = ps.figureBoxes.some(
          (fig) => intersectionRatio(line, fig) >= 0.45 || rectsOverlap(line, fig, -1)
        );
        if (insideFigure) {
          recordSkip('figure');
          continue;
        }
      }

      // 6. Figure / Table captions (and their tightly wrapped continuation lines)
      if (skipFigures) {
        if (CAPTION_START_RE.test(line.text)) {
          activeCaptionCol = line.col;
          activeCaptionBottomY = line.y + line.height;
          recordSkip('caption');
          continue;
        }
        if (
          activeCaptionCol === line.col &&
          line.y - activeCaptionBottomY <= line.height * 0.85 &&
          line.fontSize <= bodyFontSize * 0.96
        ) {
          activeCaptionBottomY = line.y + line.height;
          recordSkip('caption');
          continue;
        }
        activeCaptionCol = null;
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
 * Extract graphic/image bounding boxes from a PDF.js page's operator list
 * in top-down viewport coordinates so diagram/figure labels can be auto-skipped.
 */
export async function extractFigureBoxesFromPdfPage(pdfPage, viewport, OPS) {
  if (!pdfPage || !viewport || !OPS) return [];
  const boxes = [];
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
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintImageMaskXObject
      ) {
        // Unit square [0,0]..[1,1] transformed by CTM, then by viewport transform
        const corners = [
          transformPoint(ctm, 0, 0),
          transformPoint(ctm, 1, 0),
          transformPoint(ctm, 0, 1),
          transformPoint(ctm, 1, 1),
        ].map(([px, py]) => viewport.convertToViewportPoint(px, py));

        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const width = Math.max(...xs) - x;
        const height = Math.max(...ys) - y;

        // Ignore tiny decorative icons or full-page background scans
        const pageArea = viewport.width * viewport.height;
        const boxArea = width * height;
        if (width >= 40 && height >= 40 && boxArea < pageArea * 0.72) {
          boxes.push({ x, y, width, height });
        }
      }
    }
  } catch {
    return [];
  }
  return boxes;
}
