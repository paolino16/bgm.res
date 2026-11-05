# Desktop interface

## Direction

Operate mode. Reference the user's actual Codex desktop interface observed on 2026-11-05: neutral graphite surfaces, restrained active states, quiet separators, compact controls, and clear typography. Adapt its workspace discipline to browsing anime; the posters supply the strongest color. These are adapted themes, not official Codex assets or an exact copy.

## Hierarchy

A narrow icon rail owns application navigation. A compact page title and utility icons sit above the working area. Browsing is a continuous poster grid; organizer tasks and review files are rows, not equal-size dashboard cards. Settings use separated sections. Only the current primary action receives a solid contrasting fill.

## Controls and language

Use consistent 24-unit SVG line icons, 1.6-unit strokes, rendered at 16–19px. Repeated utilities use 34px icon buttons with accessible names. Navigation and utility descriptions appear in a shared tooltip on hover or keyboard focus. Escape, scrolling, pointer action and navigation dismiss hints. Keep primary actions, page and media titles, form labels, confirmation counts, conflicts and failure recovery visible.

## Color and typography

Default `codex-dark`: #191919 canvas, #161616 rail, #202020 surface, #ededed text. `codex-light`: #fcfcfc canvas, #f1f1f1 rail, #171717 text, #454545 secondary text. Light themes use full-opacity labels, 1.85px icon strokes and stronger form boundaries; disabled actions use legible gray instead of fading the whole button. Codex themes use neutral completion states, with amber warnings and red errors; avoid coloring ordinary text and navigation. The four previous editor themes remain selectable alternatives. Segoe UI Variable / Segoe UI / Microsoft YaHei UI, 13px base, 20px page titles, 26px work titles. Borders separate regions quietly; focused controls provide a stronger outline.

## Implementation and verification

`desktop-appearance.cjs` owns theme tokens and preference migration; `desktop-chrome.cjs` owns icons and accessible hints; `library-chrome.css` owns the compact composition. Retain virtual-poster-grid title/meta height contracts when changing card typography. Verify media, details, subtitles, organizer and settings at desktop and narrow widths, plus hover, keyboard focus, disabled and error states.
