export const ComposerSelectors = {
  Input: '[data-lexical-editor="true"][contenteditable="true"]',
} as const;

export const GallerySelectors = {
  // Each generated thumbnail card; while media is still rendering the card
  // holds a <canvas> skeleton instead of the real <img>/<video>, so presence
  // of a loaded img[data-nimg="fill"] or video[src] is what marks it "ready".
  Thumbnail: '[data-analytics-id="creation_gallery.thumbnail_click"]',
} as const;

export const GenerateButtonSelectors = {
  Image: 'button[aria-label="Generate"][data-analytics-prompt-type="images"]',
  Video: 'button[aria-label="Generate"][data-analytics-prompt-type="videos"]',
} as const;

export const StartEndFrameSelectors = {
  Toggle: 'button[data-analytics-id="creation_gallery.start_end_frame_selection_click"]',
} as const;

export const ProjectDirs = {
  Images: 'images',
  Videos: 'videos',
} as const;

export const ProjectFiles = {
  Script: 'script.json',
} as const;

export const sceneMediaSetFolder = (n: number) => `scene_${String(n).padStart(4, '0')}`;
export const sceneGeneratedImageName = (i: number) =>
  `image_${String(i + 1).padStart(4, '0')}.jpeg`;
export const sceneGeneratedVideoName = (i: number) => `video_${String(i + 1).padStart(4, '0')}.mp4`;
export const sceneRefImageName = (n: number) => `scene_${String(n).padStart(4, '0')}.jpeg`;
export const SCENE_MEDIA_FOLDER_PATTERN = /^scene_(\d+)$/;

export const VIDEO_PROMPT_PREFIX = 'Animate this image.';

export const Alarms = {
  SceneTimeout: 'scene_timeout',
} as const;
