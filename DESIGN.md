# DESIGN.md — VieNeu Read Aloud Design System

## Scene Sentence
A researcher reading a crisp white two-column machine learning paper on a sunlit desk, listening to calm Vietnamese narration with soft botanical-sage highlights gently guiding the eye line by line.

## Color Strategy
**Restrained (OKLCH only, no hex in CSS)** — anchored to brand seed `oklch(0.650 0.100 140.0)` ("moss on weathered stone — quiet botanical conservatory").

### Light Theme (Default — Daylight Conservatory)
- `--bg`: `oklch(1.000 0.000 0)` — Pure white toolbar & popovers
- `--canvas-bg`: `oklch(0.952 0.004 142)` — Soft cool-stone backdrop so white PDF pages lift gently
- `--surface`: `oklch(0.974 0.006 142)` — Subtle sage-neutral control surfaces
- `--surface-hover`: `oklch(0.946 0.012 142)` — Quiet interactive hover
- `--border`: `oklch(0.892 0.008 142)` — Hairline structural borders
- `--ink`: `oklch(0.205 0.012 142)` — Primary text (>14:1 contrast on `--bg`)
- `--muted`: `oklch(0.455 0.014 142)` — Secondary labels & metadata (>6.2:1 contrast on `--bg`)
- `--primary`: `oklch(0.485 0.102 142)` — Calm botanical sage-emerald (white text on filled primary controls)
- `--primary-hover`: `oklch(0.435 0.108 142)` — Pressed/hover primary
- `--accent`: `oklch(0.510 0.105 215)` — Calm Nordic fjord-teal for translation badges & secondary states
- `--accent-soft`: `oklch(0.942 0.024 215)` — Pale mist badge background (dark ink text)
- `--hl-paragraph`: `oklch(0.945 0.030 142 / 0.58)` — Soft sage ambient paragraph wash
- `--hl-sentence`: `oklch(0.900 0.056 142 / 0.65)` — Clear gentle sentence highlight
- `--hl-word`: `oklch(0.815 0.095 142 / 0.85)` — Crisp animated active-word focus pill
- `--focus-dim`: `oklch(0.220 0.010 142 / 0.30)` — Calm Focus Dim veil around non-active text
- `--skip-veil`: `oklch(0.870 0.010 142 / 0.32)` — Optional skipped-region indicator veil

### Soft Dusk Theme (Optional Night Reading)
- `--bg`: `oklch(0.165 0.008 142)`
- `--canvas-bg`: `oklch(0.130 0.006 142)`
- `--surface`: `oklch(0.205 0.010 142)`
- `--ink`: `oklch(0.935 0.006 142)`
- `--muted`: `oklch(0.710 0.010 142)`
- `--primary`: `oklch(0.640 0.105 142)`

## Typography
- **UI Family**: `'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif` (one crisp family in multiple weights; Vietnamese diacritics clean and legible).
- **Scale**: Fixed rem scale (1.15 ratio): `0.75rem` metadata, `0.8125rem` controls, `0.875rem` body, `0.95rem` live Vietnamese caption, `1.05rem` titles. `font-variant-numeric: tabular-nums` on timers, page numbers, and speed readouts.

## Motion Philosophy
- **Curve**: Exponential ease-out `cubic-bezier(0.16, 1, 0.3, 1)` (150–260ms). No bounce, no elastic.
- **Authored Moments**:
  1. Sliding liquid word-highlight box gliding smoothly across active words (`transform`, `width`, `height`, `opacity`).
  2. Breathing botanical waveform indicator in the Read Aloud toolbar pill while audio streams.
  3. Gentle popover disclosure (`opacity` + `translateY(-4px)` + `scale(0.98)`).
  4. Smooth Vietnamese karaoke word reveal in the bottom caption pill.
- **Accessibility**: `@media (prefers-reduced-motion: reduce)` collapses transitions to crisp crossfades/instant updates; full keyboard shortcuts (`Space` Play/Pause, `←`/`→` Prev/Next sentence, `F` Focus Dim, `S` Skip Overlay).
