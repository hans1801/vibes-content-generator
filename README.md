# Vibes Image/Video Generator

Chrome extension (WXT + React) that automates image/video generation on [vibes.ai](https://vibes.ai) from a project's `script.json`.

## Prerequisites

- Node.js

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
- Video batch (image-to-video, attaching the generated reference image as the start frame): download to `videos/scene_XXXX/`. — done.
- Both modes retry on transient failures ("Couldn't generate" / "Upload failed") before giving up on a scene, and pace requests to stay under vibes.ai's rate limits.

# JSON Converter Prompt

Copy and paste the following prompt to convert the script:

```markdown
Convert the provided video script into the following JSON structure.

For each scene, generate:

* `scene_number`
* `image_prompt`
* `video_prompt`
* `narration`

Requirements:

* `image_prompt` must be a single plain text string describing the visual scene in detail.
* `video_prompt` must be a single plain text string describing character motion, environment motion, camera movement, transition, and approximate duration.
* `narration` must preserve the original narration for the scene.
* Keep all prompts in English.
* Keep narrations in their original language.
* Return only valid JSON.
* Do not use nested prompt objects.
* Maintain visual consistency between scenes when characters or locations repeat.

Output format:

{
  "scenes": [
    {
      "scene_number": 1,
      "image_prompt": "...",
      "video_prompt": "...",
      "narration": "..."
    }
  ]
}
```

