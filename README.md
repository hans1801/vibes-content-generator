# Vibes Image/Video Generator

Chrome extension (WXT + React) that automates image/video generation on [vibes.ai](https://vibes.ai) from a project's `script.json`.

## Prerequisites

- Node.js
- npm

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

Opens a test browser profile with the extension loaded and HMR enabled.

## Build

```bash
npm run build
```

Generates `.output/chrome-mv3`. Load it via `chrome://extensions` → Developer mode → Load unpacked.

## Status

- Mode switching (Video/Image toggle on vibes.ai's composer) — done.
- Image batch: read project folder's `script.json`, send prompts, wait for generation, download to `images/scene_XXXX/`. — done.
- Video batch (image-to-video with reference image) — not implemented yet.
