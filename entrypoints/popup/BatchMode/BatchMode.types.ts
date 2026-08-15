interface ImagePrompt {
  subjects: { description: string; action: string }[];
  environment: string;
  lighting: string;
  composition: string;
  style: string;
}

interface VideoPrompt {
  motion: string;
  camera_movement: string;
}

// script.json can give either the structured object (built field by field)
// or a plain string (used as-is) for both prompt kinds — just those two
// shapes, nothing else.
export interface SceneData {
  scene_number: number;
  image_prompt: ImagePrompt | string;
  video_prompt?: VideoPrompt | string;
}
