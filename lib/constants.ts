export const ProjectDirs = {
  Images: 'images',
  Videos: 'videos',
} as const;

export const ProjectFiles = {
  Script: 'script.json',
} as const;

export const pad4 = (n: number) => String(n).padStart(4, '0');

export const sceneMediaSetFolder = (n: number) => `scene_${pad4(n)}`;
export const sceneGeneratedImageName = (i: number) => `image_${pad4(i + 1)}.jpeg`;
export const sceneGeneratedVideoName = (i: number) => `video_${pad4(i + 1)}.mp4`;
export const sceneRefImageName = (n: number) => `scene_${pad4(n)}.jpeg`;
export const sceneRefVideoName = (n: number) => `scene_${pad4(n)}.mp4`;
export const SCENE_REF_FILE_PATTERN = /^scene_(\d+)\.(jpeg|mp4)$/;

export const VIDEO_PROMPT_PREFIX = 'Animate this image.';

// The two sites this extension automates. Referenced together in the popup's
// welcome text and in the "wrong tab" batch error — single source so adding
// a third site (or renaming one) doesn't mean hunting down every mention.
export const SUPPORTED_SITES = [
  { name: 'Vibes AI', url: 'https://vibes.ai/' },
  { name: 'Google Flow', url: 'https://labs.google/fx/es/tools/flow' },
] as const;

export const Alarms = {
  SceneTimeout: 'scene_timeout',
} as const;
