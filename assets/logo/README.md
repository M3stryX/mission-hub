# Mission Hub — logo assets

Brand mark for Mission Hub: an angular, symmetrical **M monogram**, flat gold.

| File | Version | Use on | Contrast (WCAG 1.4.11, min 3:1) |
|---|---|---|---|
| `mission-hub-primary.svg` | Primary — flat control gold `#c9a227` | **Dark surfaces only** | 8.27:1 on `#07080d` ✅ — **2.18:1 on `#f5f3ef` ✗** |
| `mission-hub-reversed.svg` | Reversed — flat cream `#f5f3ef` | Dark surfaces | 18.05:1 on `#07080d` ✅ |
| `mission-hub-mono.svg` | Monochrome — flat ink `#07080d` | **Light surfaces** | 18.05:1 on `#f5f3ef` ✅ |
| `preview-usage.png` | Usage matrix (rendered from these SVGs) | Documentation only | — |

## Colour source

Colours come from the NYC Night design tokens, the visual SSOT:
`Piblox-Studio/packages/design/src/nyc-night.css` (`--p-gold #c9a227`, `--p-void #07080d`,
`--foreground #f5f3ef`). Do not introduce hex values outside those tokens.

## Rules

- **No gradient and no filter.** The mark is a flat single-colour path; effects (glow, shadow)
  are not part of the identity.
- **`primary` is dark-surface only.** Flat gold on a light surface measures 2.18:1, below the
  3:1 minimum for non-text content — use `mono` there instead. That is the reason this set has
  a light-surface variant at all.
- Keep `width`/`height`/`viewBox` intact (156×98) and scale via CSS.
- Clear space: leave a margin of at least the monogram's height around the mark, on every side,
  with nothing intruding.
- Do not recolour, stretch, crop, or add effects without updating this README.

## Provenance

Moved into this repository from `cockpit/knowledge/mission-hub/logo/` (moved, not copied —
no duplicate is kept elsewhere). The monogram path is an editable vector recreation of the
original raster mark. The earlier gradient/glow variants were retired when the identity was
aligned to the NYC Night tokens.
