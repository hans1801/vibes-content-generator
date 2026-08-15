import { VIDEO_PROMPT_PREFIX } from '../../../../lib/constants';
import type { SceneData } from './BatchMode.types';

const clean = (s?: string) => s?.trim() ?? '';

export function buildImagePrompt(scene: SceneData): string {
  const ip = scene.image_prompt;
  if (typeof ip === 'string') return clean(ip);
  const subjects = ip.subjects.map((s) => `${clean(s.description)} ${clean(s.action)}`).join(' ');
  return [subjects, ip.environment, ip.lighting, ip.composition, ip.style]
    .map(clean)
    .filter(Boolean)
    .join(' ');
}

export function buildVideoPrompt(scene: SceneData): string {
  const vp = scene.video_prompt;
  if (!vp) return VIDEO_PROMPT_PREFIX;
  if (typeof vp === 'string') return `${VIDEO_PROMPT_PREFIX} ${clean(vp)}`.trim();
  const strip = (s?: string) => clean(s).replace(/\.$/, '');
  return `${VIDEO_PROMPT_PREFIX} ${strip(vp.motion)} ${strip(vp.camera_movement)}`.trim();
}

export function getPreCompleted(allScenes: SceneData[], pendingScenes: SceneData[]): number[] {
  const pendingNums = new Set(pendingScenes.map((s) => s.scene_number));
  return allScenes.map((s) => s.scene_number).filter((n) => !pendingNums.has(n));
}
