# Vibes Image/Video Generator

Chrome extension (WXT + React) that automates image/video generation on [vibes.ai](https://vibes.ai) from a project's `script.json`.

## Prerequisites

- Node.js

## Installation

Clone the repo and install dependencies:

```bash
git clone https://github.com/hans1801/vibes-image-video-generator.git
cd vibes-image-video-generator
npm install
```

## Build and Load in Chrome

If you want to compile the final version of the extension or install it in your main Chrome profile:

1. Run the build command:

   ```bash
   npm run build
   ```

2. This will generate a folder named `.output/chrome-mv3` (or similar) in the root of your project.
3. Open your Chrome browser and go to: `chrome://extensions/`
4. Enable **Developer mode** (toggle in the top right corner).
5. Click on the **Load unpacked** button in the top left.
6. Select the `.output/chrome-mv3` folder that was just generated.

Done! The extension will now be installed in your main browser.

## Development Mode (Dev)

To run the project in development mode and see changes in real-time, simply run:

```bash
npm run dev
```

**What does this command do?**
- Starts the local development server with Hot Module Replacement (HMR).
- **Automatically opens a new browser window** configured as a test profile, with your extension already installed and ready to use.

*Note: If you close the test browser, you can press `o + enter` in the terminal where the script is running to open it again.*

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

