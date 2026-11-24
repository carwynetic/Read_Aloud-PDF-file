import { describe, it, expect } from 'vitest';
import { analyzeDocumentPages } from '../core/pdfLayoutAnalyzer.js';

/**
 * Helper to create a synthetic PDF.js text item in top-down viewport coordinates
 * (pageWidth = 600, pageHeight = 800).
 */
function item(str, x, y, width, height = 10) {
  return { str, x, y, width, height };
}

describe('pdfLayoutAnalyzer', () => {
  it('skips running headers, page numbers, conference footers, and footnotes', () => {
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          // Running header near top
          item('A Simple Framework for Contrastive Learning', 140, 32, 320, 9),
          // Body paragraph
          item('Contrastive learning learns visual representations.', 60, 140, 230, 11),
          item('It achieves strong performance without labels.', 60, 156, 220, 11),
          // Footnote / conference footer at bottom
          item('1Google Research, Brain Team. Correspondence to: author@google.com.', 60, 700, 230, 8),
          item('Proceedings of the 37th International Conference on Machine Learning, 2020.', 60, 725, 240, 8),
          item('Copyright 2020 by the author(s).', 60, 738, 160, 8),
          // Standalone page number
          item('1', 298, 768, 8, 9),
        ],
      },
      {
        pageNumber: 2,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          item('A Simple Framework for Contrastive Learning', 140, 32, 320, 9),
          item('Data augmentation plays a critical role.', 60, 140, 210, 11),
          item('2', 298, 768, 8, 9),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages);
    const spokenTexts = doc.sentences.map((s) => s.text);

    expect(spokenTexts).toEqual([
      'Contrastive learning learns visual representations.',
      'It achieves strong performance without labels.',
      'Data augmentation plays a critical role.',
    ]);

    const skipReasons = doc.skippedRegions.map((r) => r.reason);
    expect(skipReasons).toContain('header');
    expect(skipReasons).toContain('page-number');
    expect(skipReasons).toContain('footer');
  });

  it('skips text inside figure graphic boxes and Figure/Table captions', () => {
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [
          { x: 310, y: 120, width: 230, height: 180 },
        ],
        items: [
          // Left column body
          item('Composition of data augmentations is crucial.', 60, 140, 220, 11),
          // Text sitting inside the figure diagram on the right
          item('Maximize agreement', 380, 150, 90, 9),
          item('zi', 340, 175, 14, 9),
          item('zj', 490, 175, 14, 9),
          item('Representation', 395, 250, 70, 9),
          // Figure caption right below
          item('Figure 1: A simple framework for contrastive learning of visual representations.', 315, 312, 225, 9),
          // Next real body sentence below caption
          item('In order to understand what enables good representations, we study each component.', 315, 360, 225, 11),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages);
    const spokenTexts = doc.sentences.map((s) => s.text);

    expect(spokenTexts).toEqual([
      'Composition of data augmentations is crucial.',
      'In order to understand what enables good representations, we study each component.',
    ]);

    const skippedReasons = doc.skippedRegions.map((r) => r.reason);
    expect(skippedReasons).toContain('figure');
    expect(skippedReasons).toContain('caption');
  });

  it('reads two-column academic layout in left-column-first then right-column order', () => {
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          // Left column lines
          item('Left first sentence ends here.', 55, 140, 215, 11),
          item('Left second sentence follows below.', 55, 158, 220, 11),
          item('Left third sentence completes left.', 55, 176, 210, 11),
          // Right column lines at same Y coordinates
          item('Right first sentence starts column two.', 325, 140, 220, 11),
          item('Right second sentence follows below.', 325, 158, 215, 11),
          item('Right third sentence finishes page.', 325, 176, 210, 11),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages);
    const texts = doc.sentences.map((s) => s.text);

    expect(texts).toEqual([
      'Left first sentence ends here.',
      'Left second sentence follows below.',
      'Left third sentence completes left.',
      'Right first sentence starts column two.',
      'Right second sentence follows below.',
      'Right third sentence finishes page.',
    ]);
  });

  it('skips vertical rotated margin watermarks like arXiv stamps', () => {
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          { str: 'arXiv:2002.05709v3 [cs.LG] 1 Jul 2020', x: 18, y: 360, width: 14, height: 220, rotated: true },
          item('This paper presents SimCLR for visual representations.', 90, 260, 220, 11),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages);
    expect(doc.sentences.map((s) => s.text)).toEqual([
      'This paper presents SimCLR for visual representations.',
    ]);
    expect(doc.skippedRegions.map((r) => r.reason)).toContain('watermark');
  });

  it('produces normalized paragraph, sentence, and per-word bounding boxes and handles abbreviations', () => {
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          item('Generative models e.g. VAEs learn pixels.', 60, 200, 220, 12),
          item('They also support dis-', 60, 218, 120, 12),
          item('criminative tasks well.', 60, 236, 130, 12),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages);
    expect(doc.paragraphs.length).toBe(1);
    expect(doc.sentences.length).toBe(2);
    expect(doc.sentences[0].text).toBe('Generative models e.g. VAEs learn pixels.');
    expect(doc.sentences[1].text).toBe('They also support discriminative tasks well.');

    // Check normalized word rects (0..1)
    const firstSentence = doc.sentences[0];
    expect(firstSentence.words.length).toBeGreaterThanOrEqual(6);
    for (const w of firstSentence.words) {
      expect(w.x).toBeGreaterThanOrEqual(0);
      expect(w.x).toBeLessThanOrEqual(1);
      expect(w.y).toBeGreaterThanOrEqual(0);
      expect(w.y).toBeLessThanOrEqual(1);
      expect(w.width).toBeGreaterThan(0);
      expect(w.height).toBeGreaterThan(0);
    }
  });
});
