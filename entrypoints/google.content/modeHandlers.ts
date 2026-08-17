import { Actions, LogKinds, LogLevels, BatchModes } from '../../lib/types';
import type { BatchMode } from '../../lib/types';
import {
  MEDIA_POLL_INTERVAL_MS,
  IMAGE_MEDIA_POLL_MAX_ATTEMPTS,
  VIDEO_MEDIA_POLL_MAX_ATTEMPTS,
  MAX_GENERATION_ATTEMPTS,
  IMAGE_SCENE_RETRY_DELAY_MS,
  VIDEO_SCENE_RETRY_DELAY_MS,
} from './constants';
import { aborted } from './abortState';
import { log } from './log';
import { sleep } from './domUtils';
import { getComposer, fillSlateComposer, submitPrompt } from './composer';
import { attachStartFrame } from './startFrame';
import {
  getMediaTileIds,
  blobUrlToDataUrl,
  waitForNewMedia,
  reportSceneFailed,
  MediaPollStatuses,
} from './mediaPolling';

// ── Composer helper ───────────────────────────────────────────────────────────

// Grabs the composer, fills the prompt and submits it. Returns the composer
// on success or null on any failure, having already reported it.
async function fillComposerAndSubmit(
  prompt: string,
  sceneNumber: number,
  retryDelayMs: number,
  preSubmitDelayMs = 0
): Promise<HTMLElement | null> {
  const composer = getComposer();
  if (!composer) {
    await reportSceneFailed(sceneNumber, 'Editor de Google Flow no encontrado.', retryDelayMs);
    return null;
  }

  const filled = await fillSlateComposer(composer, prompt);
  if (!filled) {
    await reportSceneFailed(
      sceneNumber,
      'No se pudo escribir el prompt en Google Flow.',
      retryDelayMs
    );
    return null;
  }

  if (preSubmitDelayMs > 0) await sleep(preSubmitDelayMs);

  const submitted = await submitPrompt(composer);
  if (!submitted) {
    await reportSceneFailed(
      sceneNumber,
      'No se pudo hacer clic en el botón de enviar.',
      retryDelayMs
    );
    return null;
  }

  return composer;
}

// ── Generation wait + download ────────────────────────────────────────────────

// Shared by both modes — owns the whole send→wait cycle, attempt 1 included
// (it's just attempt 1 of the same loop, not a special case). Each caller
// already knows its own mode, so it passes its own wording/timing directly
// instead of this function branching on it internally.
async function waitForGenerationAndDownload(
  prompt: string,
  sceneNumber: number,
  mode: BatchMode,
  retryDelayMs: number,
  waitStep: string,
  waitCooldownMs: number,
  timeoutReason: string,
  preSubmitDelayMs = 0,
  // Video only — a failed attempt can drop the attached start frame, so it
  // needs to be re-checked (and re-uploaded if gone) before every resubmit,
  // not just the first one.
  ensureReadyToSubmit?: () => Promise<boolean>
) {
  let beforeIds = getMediaTileIds();

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    if (aborted) return;

    if (ensureReadyToSubmit && !(await ensureReadyToSubmit())) {
      await reportSceneFailed(sceneNumber, 'No se pudo adjuntar el start frame.', retryDelayMs);
      return;
    }

    const composer = await fillComposerAndSubmit(
      prompt,
      sceneNumber,
      retryDelayMs,
      preSubmitDelayMs
    );
    if (!composer) return;

    log({
      sceneNumber,
      step: waitStep,
      kind: LogKinds.Info,
      level: LogLevels.Step,
      attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
      cooldownMs: waitCooldownMs,
    });

    const result = await waitForNewMedia(beforeIds, mode);

    switch (result.status) {
      case MediaPollStatuses.Aborted:
        return;

      case MediaPollStatuses.Success:
        log({
          sceneNumber,
          step:
            mode === BatchModes.Video
              ? 'Video listo, descargando'
              : `${result.urls.length} imagen(es) lista(s), descargando`,
          kind: LogKinds.Success,
          level: LogLevels.Step,
        });

        await browser.runtime.sendMessage({
          action: Actions.DownloadMediaDirect,
          urls: await Promise.all(
            result.urls.map(async (url) => {
              // blob: URLs are page-bound — the popup can't fetch them, so
              // convert to a portable data: URL here instead.
              if (url.startsWith('blob:')) {
                try {
                  return await blobUrlToDataUrl(url);
                } catch {
                  return url;
                }
              }
              // Tile srcs can be relative (e.g. /fx/api/trpc/...) — resolve
              // against the page's origin so the popup can fetch it directly.
              return new URL(url, location.href).href;
            })
          ),
          sceneNumber,
        });
        return;

      case MediaPollStatuses.NoSuccess:
        beforeIds = getMediaTileIds();
        if (attempt >= MAX_GENERATION_ATTEMPTS) {
          log({
            sceneNumber,
            step: 'Tiempo agotado, saltando escena',
            kind: LogKinds.Error,
            level: LogLevels.Step,
          });
          await reportSceneFailed(sceneNumber, timeoutReason, retryDelayMs);
          return;
        }
        break;
    }
  }
}

// ── Image handler ─────────────────────────────────────────────────────────────

export async function handleImageMode(prompt: string, sceneNumber: number) {
  log({
    sceneNumber,
    step: 'Generando imagen en Google Flow',
    kind: LogKinds.Info,
    level: LogLevels.Mode,
  });

  await waitForGenerationAndDownload(
    prompt,
    sceneNumber,
    BatchModes.Image,
    IMAGE_SCENE_RETRY_DELAY_MS,
    'Esperando imagen',
    IMAGE_MEDIA_POLL_MAX_ATTEMPTS * MEDIA_POLL_INTERVAL_MS,
    'Tiempo agotado esperando la imagen.'
  );
}

// ── Video handler ─────────────────────────────────────────────────────────────

export async function handleVideoMode(
  prompt: string,
  imageBase64: string | null,
  imageName: string | null,
  sceneNumber: number
) {
  if (!imageBase64 || !imageName) {
    await reportSceneFailed(
      sceneNumber,
      'Imagen de referencia requerida para video.',
      VIDEO_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  log({
    sceneNumber,
    step: 'Preparando video en Google Flow',
    kind: LogKinds.Info,
    level: LogLevels.Mode,
  });

  await waitForGenerationAndDownload(
    prompt,
    sceneNumber,
    BatchModes.Video,
    VIDEO_SCENE_RETRY_DELAY_MS,
    'Esperando video (puede tardar varios minutos)',
    VIDEO_MEDIA_POLL_MAX_ATTEMPTS * MEDIA_POLL_INTERVAL_MS,
    'Tiempo agotado esperando el video.',
    3000,
    () => attachStartFrame(imageBase64, imageName, sceneNumber)
  );
}
