# bgm.res

## Product and platform

Windows Electron desktop application for managing a local anime collection. The existing CommonJS renderer, IPC interfaces and Python organizer engine remain the implementation constraints.

## User and workflows

The user browses a real local library, opens videos, tracks episodes, checks subtitle coverage, and reviews file-to-episode mappings before organizing files. Preserve review confirmations, background AI work, conflict checks, import previews, and persistent local preferences.

## Confirmed design commitments

The user requested Codex as the interface reference on 2026-11-05, replacing the previous colorful editor-palette default. They explicitly prefer more icons, less persistent text, and explanatory labels on hover. Keep important page titles, media names, primary task actions and consequential operation details readable. Keep accessible names and keyboard-accessible explanations on icon controls.

## Content

Use the user's existing library metadata and cover art. Do not change factual media titles or invent library records. Demonstration data belongs only in isolated QA fixtures.
