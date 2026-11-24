# PRODUCT.md — VieNeu Read Aloud (PDF EN → VI)

## Purpose
A Chrome/Edge Manifest V3 browser extension and companion local VieNeu-TTS server that transforms English academic and technical PDFs into natural, real-time Vietnamese audio read-aloud with synchronized paragraph, sentence, and word highlighting directly on the PDF document.

## Target User & Scene
A Vietnamese researcher, student, or engineer reading dense two-column English PDFs (arXiv papers, technical specs, textbooks) at their desk in daylight or quiet evening light. They want to follow along visually on the original English page while listening to fluent Vietnamese narration powered by their local VieNeu-TTS engine, without being interrupted by running headers, page numbers, footnotes, or diagram labels.

## Surface Mode
**Operate + Read** — The chrome disappears into calm precision so the PDF document remains the visual hero. Familiarity with Edge/Chrome's native Read Aloud toolbar makes controls immediately legible, while gentle motion and color keep multi-hour reading effortless.

## Core Capabilities
1. **PDF Viewer & Extension**: Opens any remote PDF URL or local PDF file (drag-and-drop, file picker, or 1-click from active PDF tab) with crisp PDF.js rendering.
2. **Smart Layout Filtering**: Multi-column reading-order reconstruction (1-col & 2-col academic papers) + automatic skipping of running headers, footers, page numbers, footnotes, figures/diagram text, and figure/table captions (with toggleable visibility and click-to-read override).
3. **EN → VI Translation + VieNeu-TTS**: Connects to local `VieNeu-TTS v3 Turbo` (reusing the existing `OpenMAIC/vieneu-server` venv or running server on `:8000`) with preset Vietnamese voices and instant voice cloning, plus pluggable EN→VI translation (free zero-config Google Translate or optional OpenAI-compatible LLM).
4. **3-Tier Synchronized Highlighting**:
   - Paragraph ambient wash + optional Focus Dim veil.
   - Active sentence highlight on the original PDF with smooth auto-scroll.
   - Active word sweeping highlight on the PDF + live Vietnamese karaoke caption bar synced to audio energy envelope timestamps.
5. **Lookahead Prefetch & Caching**: Prefetches upcoming sentences while current audio plays and caches translations/WAVs locally for zero-lag replay.
