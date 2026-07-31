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
export const sceneRefVideoName = (n: number) => `scene_${String(n).padStart(4, '0')}.mp4`;
export const SCENE_MEDIA_FOLDER_PATTERN = /^scene_(\d+)$/;

export const VIDEO_PROMPT_PREFIX = 'Animate this image.';

export const Alarms = {
  SceneTimeout: 'scene_timeout',
} as const;
