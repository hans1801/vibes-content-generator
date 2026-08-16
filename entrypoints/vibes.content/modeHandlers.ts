import { BatchModes, LogKinds, LogLevels } from '../../lib/types';
import { GenerateButtonSelectors } from '../../lib/selectors/vibes';
import {
  IMAGE_SCENE_RETRY_DELAY_MS,
  VIDEO_SCENE_RETRY_DELAY_MS,
  IMAGE_BATCH_SETTLE_TIMEOUT_MS,
  VIDEO_BATCH_SETTLE_TIMEOUT_MS,
} from './constants';
import { log } from './log';
import { ensureMode, createGenerateAttempt } from './modeSwitch';
import { attachStartFrame, removeStartFrame } from './startFrame';
import { generateWithRetries, reportSceneFailed } from './mediaPolling';

// ── Mode handlers ─────────────────────────────────────────────────────────────

export async function handleImageMode(prompt: string, sceneNumber: number) {
  log({ sceneNumber, step: 'Generando imagen', kind: LogKinds.Info, level: LogLevels.Mode });

  const switched = await ensureMode(BatchModes.Image);
  if (!switched) {
    await reportSceneFailed(
      sceneNumber,
      'No se pudo activar el modo imagen.',
      IMAGE_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  const generateAttempt = createGenerateAttempt(prompt, GenerateButtonSelectors.Image);

  generateWithRetries(
    sceneNumber,
    BatchModes.Image,
    generateAttempt,
    IMAGE_SCENE_RETRY_DELAY_MS,
    IMAGE_BATCH_SETTLE_TIMEOUT_MS
  );
}

export async function handleVideoMode(
  prompt: string,
  imageBase64: string | null,
  imageName: string | null,
  sceneNumber: number
) {
  if (!imageBase64 || !imageName) {
    await reportSceneFailed(
      sceneNumber,
      'Falta la imagen de referencia para el video.',
      VIDEO_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  log({ sceneNumber, step: 'Generando video', kind: LogKinds.Info, level: LogLevels.Mode });

  const switched = await ensureMode(BatchModes.Video);
  if (!switched) {
    await reportSceneFailed(
      sceneNumber,
      'No se pudo activar el modo video.',
      VIDEO_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  const attached = await attachStartFrame(imageBase64, imageName, sceneNumber);
  if (!attached) {
    await reportSceneFailed(
      sceneNumber,
      'No se pudo adjuntar el start frame.',
      VIDEO_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  const generateAttempt = createGenerateAttempt(prompt, GenerateButtonSelectors.Video);

  await generateWithRetries(
    sceneNumber,
    BatchModes.Video,
    generateAttempt,
    VIDEO_SCENE_RETRY_DELAY_MS,
    VIDEO_BATCH_SETTLE_TIMEOUT_MS
  );

  await removeStartFrame();
}
