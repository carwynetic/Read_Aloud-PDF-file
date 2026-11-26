import { describe, it, expect } from 'vitest';
import {
  analyzeDocumentPages,
  extractFigureBoxesFromPdfPage,
} from '../core/pdfLayoutAnalyzer.js';

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

  it('skips text inside figure graphic boxes while reading Figure/Table captions by default (skipCaptions: false)', () => {
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

    const docDefault = analyzeDocumentPages(pages);
    expect(docDefault.sentences.map((s) => s.text)).toEqual([
      'Composition of data augmentations is crucial.',
      'Figure 1: A simple framework for contrastive learning of visual representations.',
      'In order to understand what enables good representations, we study each component.',
    ]);
    expect(docDefault.skippedRegions.map((r) => r.reason)).toContain('figure');
    expect(docDefault.skippedRegions.map((r) => r.reason)).not.toContain('caption');

    // When user explicitly enables skipCaptions: true, captions are skipped too
    const docSkipCap = analyzeDocumentPages(pages, { skipCaptions: true });
    expect(docSkipCap.sentences.map((s) => s.text)).toEqual([
      'Composition of data augmentations is crucial.',
      'In order to understand what enables good representations, we study each component.',
    ]);
    expect(docSkipCap.skippedRegions.map((r) => r.reason)).toContain('caption');
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

  it('skips angle-bracketed footer emails and continuation lines like "the author(s)."', () => {
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          item('Learning effective visual representations is important.', 55, 420, 230, 11),
          // Footnote & conference footer block at bottom of left column
          item('1Google Research, Brain Team. Correspondence to: Ting Chen', 55, 650, 230, 8.2),
          item('<iamtingchen@google.com>.', 55, 661, 120, 8.2),
          item('Proceedings of the 37th International Conference on Machine', 55, 678, 230, 8.2),
          item('Learning, Vienna, Austria, PMLR 119, 2020. Copyright 2020 by', 55, 689, 230, 8.2),
          item('the author(s).', 55, 700, 62, 8.2),
          item('1Code available at https://github.com/google-research/simclr.', 55, 714, 225, 8.2),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages);
    expect(doc.sentences.map((s) => s.text)).toEqual([
      'Learning effective visual representations is important.',
    ]);
    expect(doc.skippedRegions.length).toBe(6);
  });

  it('skips kerning-split Figure captions and chart labels sitting above a Figure caption', () => {
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          // Left column body
          item('This paper presents SimCLR for visual representations.', 55, 220, 225, 10.5),
          item('It simplifies contrastive self-supervised learning algorithms.', 55, 236, 225, 10.5),
          item('We evaluate linear classifiers on ImageNet.', 55, 252, 215, 10.5),
          // Right column scatter plot labels ABOVE Figure 1 caption (even without image XObject)
          item('Supervised', 330, 190, 48, 8.5),
          item('SimCLR (4x)', 465, 190, 58, 8.5),
          item('SimCLR (2x)', 410, 208, 56, 8.5),
          item('70', 318, 226, 12, 8),
          item('SimCLR', 345, 228, 38, 8.5),
          item('CPCv2-L', 452, 226, 40, 8),
          item('65', 318, 248, 12, 8),
          item('BigBiGAN', 405, 265, 44, 8),
          item('25 50 100 200 400 626', 330, 305, 185, 8),
          item('Number of Parameters (Millions)', 365, 318, 130, 8.5),
          // Kerning-split "F" + "igure 1." caption right below plot
          item('F', 315, 342, 6, 9),
          item('igure 1. ImageNet Top-1 accuracy of linear classifiers trained', 321, 342, 220, 9),
          item('on representations learned with different methods.', 315, 354, 210, 9),
          // Real body paragraph below caption
          item('However, pixel-level generation is computationally expensive.', 315, 392, 225, 10.5),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages, { skipCaptions: true });
    expect(doc.sentences.map((s) => s.text)).toEqual([
      'This paper presents SimCLR for visual representations.',
      'It simplifies contrastive self-supervised learning algorithms.',
      'We evaluate linear classifiers on ImageNet.',
      'However, pixel-level generation is computationally expensive.',
    ]);

    // With default skipCaptions: false, chart labels are STILL skipped while Figure 1 caption IS read
    const docWithCaption = analyzeDocumentPages(pages);
    expect(docWithCaption.sentences.map((s) => s.text)).toEqual([
      'This paper presents SimCLR for visual representations.',
      'It simplifies contrastive self-supervised learning algorithms.',
      'We evaluate linear classifiers on ImageNet.',
      'Figure 1.',
      'ImageNet Top-1 accuracy of linear classifiers trained on representations learned with different methods.',
      'However, pixel-level generation is computationally expensive.',
    ]);
  });

  it('does not misclassify body prose starting with "Figure 9 shows..." or wrapped "...as shown in\\nFigure 3." as a caption', () => {
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          item('This creates a family of predictive tasks, as shown in', 55, 420, 230, 10.5),
          item('Figure 3. This simple design decouples the task.', 55, 434, 220, 10.5),
          item('Figure 9 shows the impact of batch size on training.', 55, 470, 225, 10.5),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages, { skipCaptions: true });
    expect(doc.sentences.map((s) => s.text)).toEqual([
      'This creates a family of predictive tasks, as shown in Figure 3.',
      'This simple design decouples the task.',
      'Figure 9 shows the impact of batch size on training.',
    ]);
    expect(doc.skippedRegions.filter((r) => r.reason === 'caption').length).toBe(0);
  });

  it('does not misclassify a large Page 1 title as a running header when Page 2 repeats it in smaller font', () => {
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          item('A Simple Framework for Contrastive Learning', 90, 74, 420, 16),
          item('This paper presents SimCLR.', 55, 200, 220, 10.5),
        ],
      },
      {
        pageNumber: 2,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          item('A Simple Framework for Contrastive Learning', 160, 42, 280, 9),
          item('Composition of data augmentations is crucial.', 55, 140, 220, 10.5),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages);
    expect(doc.sentences[0].text).toBe('A Simple Framework for Contrastive Learning');
    expect(doc.sentences.map((s) => s.text)).toContain('Composition of data augmentations is crucial.');
    // Page 2 running header IS skipped
    expect(doc.skippedRegions.some((r) => r.pageNumber === 2 && r.reason === 'header')).toBe(true);
    // Page 1 large title is NOT skipped
    expect(doc.skippedRegions.some((r) => r.pageNumber === 1 && r.reason === 'header')).toBe(false);
  });

  it('extractFigureBoxesFromPdfPage detects vector chart/diagram clusters while ignoring thin horizontal rules', async () => {
    const OPS = {
      save: 10,
      restore: 11,
      transform: 12,
      moveTo: 13,
      lineTo: 14,
      curveTo: 15,
      rectangle: 19,
      constructPath: 91,
      paintImageXObject: 85,
      paintInlineImageXObject: 86,
      paintImageMaskXObject: 83,
    };

    const fakePage = {
      async getOperatorList() {
        return {
          fnArray: [
            // Thin horizontal header divider rule across page (should be IGNORED!)
            OPS.constructPath,
            // Vector scatter plot axes + dashed lines in right column (x: 320..520, y: 500..650 in PDF coords)
            OPS.constructPath,
            OPS.constructPath,
          ],
          argsArray: [
            [[OPS.moveTo, OPS.lineTo], [55, 740, 545, 740]],
            [[OPS.moveTo, OPS.lineTo, OPS.lineTo], [320, 650, 320, 500, 520, 500]],
            [[OPS.rectangle], [350, 540, 120, 80]],
          ],
        };
      },
    };

    const viewport = {
      width: 600,
      height: 800,
      convertToViewportPoint: (x, y) => [x, 800 - y],
    };

    const boxes = await extractFigureBoxesFromPdfPage(fakePage, viewport, OPS);
    expect(boxes.length).toBe(1);
    expect(boxes[0].x).toBeLessThanOrEqual(320);
    expect(boxes[0].width).toBeGreaterThanOrEqual(190);
    expect(boxes[0].height).toBeGreaterThanOrEqual(140);
  });

  it('keeps single-column LaTeX pages (many small word items per line) in natural full-line reading order without splitting left/right', () => {
    // Simulates a single-column arXiv paper like KAN where PDF.js splits each line into small word items
    const pages = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        figureBoxes: [],
        items: [
          // Title
          item('KAN: Kolmogorov–Arnold Networks', 150, 100, 300, 16),
          // Authors split into small items across the line
          item('Ziming Liu', 110, 145, 70, 10),
          item('Yixuan Wang', 195, 145, 80, 10),
          item('Sachin Vaidya', 290, 145, 85, 10),
          item('Fabian Ruehle', 390, 145, 85, 10),
          // Abstract heading
          item('Abstract', 275, 220, 50, 12),
          // Single-column body lines split into small word-level items crossing midX (300)
          item('Inspired by the', 90, 250, 80, 10.5),
          item('Kolmogorov-Arnold', 175, 250, 95, 10.5),
          item('representation theorem,', 275, 250, 115, 10.5),
          item('we propose KANs.', 395, 250, 95, 10.5),

          item('While MLPs have', 90, 266, 85, 10.5),
          item('fixed activation functions on', 180, 266, 130, 10.5),
          item('nodes ("neurons"),', 315, 266, 95, 10.5),
          item('KANs have learnable', 415, 266, 95, 10.5),

          item('activation functions on', 90, 282, 115, 10.5),
          item('edges ("weights").', 210, 282, 95, 10.5),
          item('KANs have no linear', 310, 282, 100, 10.5),
          item('weights at all.', 415, 282, 85, 10.5),
        ],
      },
    ];

    const doc = analyzeDocumentPages(pages);
    expect(doc.sentences.map((s) => s.text)).toEqual([
      'KAN: Kolmogorov–Arnold Networks',
      'Ziming Liu Yixuan Wang Sachin Vaidya Fabian Ruehle',
      'Abstract',
      'Inspired by the Kolmogorov-Arnold representation theorem, we propose KANs.',
      'While MLPs have fixed activation functions on nodes ("neurons"), KANs have learnable activation functions on edges ("weights").',
      'KANs have no linear weights at all.',
    ]);
  });
});
