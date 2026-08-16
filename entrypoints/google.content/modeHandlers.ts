import { Actions, LogKinds, LogLevels } from '../../lib/types';
import {
  MEDIA_POLL_INTERVAL_MS,
  MEDIA_POLL_MAX_ATTEMPTS,
  MAX_GENERATION_ATTEMPTS,
  GENERATION_RETRY_DELAY_MS,
  IMAGE_SCENE_RETRY_DELAY_MS,
  VIDEO_SCENE_RETRY_DELAY_MS,
} from './constants';
import { aborted } from './abortState';
import { log } from './log';
import { sleep, sleepAbortable, base64ToFile } from './domUtils';
import { getComposer, fillSlateComposer, submitPrompt } from './composer';
import { switchToVideoMode } from './modeSwitch';
import {
  getMediaTileIds,
  blobUrlToDataUrl,
  waitForNewMedia,
  reportSceneFailed,
  MediaPollStatuses,
} from './mediaPolling';

// ── Image handler ─────────────────────────────────────────────────────────────

export async function handleImageMode(prompt: string, sceneNumber: number) {
  log({
    sceneNumber,
    step: 'Generando imagen en Google Flow',
    kind: LogKinds.Info,
    level: LogLevels.Mode,
  });

  const composer = getComposer();
  if (!composer) {
    await reportSceneFailed(
      sceneNumber,
      'Editor de Google Flow no encontrado.',
      IMAGE_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  const filled = await fillSlateComposer(composer, prompt);
  if (!filled) {
    await reportSceneFailed(
      sceneNumber,
      'No se pudo escribir el prompt en Google Flow.',
      IMAGE_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  const submitted = await submitPrompt(composer);
  if (!submitted) {
    await reportSceneFailed(
      sceneNumber,
      'No se pudo hacer clic en el botón de enviar.',
      IMAGE_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  const beforeIds = getMediaTileIds();

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    if (aborted) return;

    log({
      sceneNumber,
      step: 'Esperando imagen',
      kind: LogKinds.Info,
      level: LogLevels.Step,
      attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
      cooldownMs: MEDIA_POLL_MAX_ATTEMPTS * MEDIA_POLL_INTERVAL_MS,
    });

    const result = await waitForNewMedia(beforeIds);

    if (result.status === MediaPollStatuses.Aborted) return;
    if (result.status === MediaPollStatuses.Crashed) {
      log({
        sceneNumber,
        step: 'La página de Google Flow crasheó, saltando escena',
        kind: LogKinds.Error,
        level: LogLevels.Step,
      });
      await reportSceneFailed(sceneNumber, 'La página crasheó.', IMAGE_SCENE_RETRY_DELAY_MS);
      return;
    }

    if (result.status === MediaPollStatuses.Timeout) {
      if (attempt >= MAX_GENERATION_ATTEMPTS) {
        log({
          sceneNumber,
          step: 'Tiempo agotado, saltando escena',
          kind: LogKinds.Error,
          level: LogLevels.Step,
        });
        await reportSceneFailed(
          sceneNumber,
          'Tiempo agotado esperando la imagen.',
          IMAGE_SCENE_RETRY_DELAY_MS
        );
        return;
      }
      log({
        sceneNumber,
        step: 'Tiempo agotado, reintentando',
        kind: LogKinds.Retry,
        level: LogLevels.Step,
        attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
        cooldownMs: GENERATION_RETRY_DELAY_MS,
      });
      await sleepAbortable(GENERATION_RETRY_DELAY_MS);
      if (aborted) return;

      const refilled = await fillSlateComposer(composer, prompt);
      const resubmitted = refilled && (await submitPrompt(composer));
      if (!resubmitted) {
        log({
          sceneNumber,
          step: 'No se pudo reintentar, saltando escena',
          kind: LogKinds.Error,
          level: LogLevels.Step,
        });
        await reportSceneFailed(
          sceneNumber,
          'No se pudo reintentar el envío.',
          IMAGE_SCENE_RETRY_DELAY_MS
        );
        return;
      }
      continue;
    }

    // success
    log({
      sceneNumber,
      step: `${result.urls.length} imagen(es) lista(s), descargando`,
      kind: LogKinds.Success,
      level: LogLevels.Step,
    });

    const finalUrls = await Promise.all(
      result.urls.map(async (url) => {
        if (!url.startsWith('blob:')) return url;
        try {
          return await blobUrlToDataUrl(url);
        } catch {
          // Keep the blob URL as fallback; the popup's fetchBlobWithRetry may handle it.
          return url;
        }
      })
    );

    await browser.runtime.sendMessage({
      action: Actions.DownloadMediaDirect,
      urls: finalUrls,
      sceneNumber,
    });
    return;
  }
}

// ── Video handler ─────────────────────────────────────────────────────────────

export async function handleVideoMode(
  prompt: string,
  imageBase64: string | null,
  imageName: string | null,
  sceneNumber: number
) {
  log({
    sceneNumber,
    step: 'Preparando video en Google Flow',
    kind: LogKinds.Info,
    level: LogLevels.Mode,
  });

  const composer = getComposer();
  if (!composer) {
    await reportSceneFailed(
      sceneNumber,
      'Editor de Google Flow no encontrado.',
      VIDEO_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  // 1. Cambiar la UI a modo Video
  const isVideoMode = await switchToVideoMode();
  if (!isVideoMode) {
    // Si falla el cambio de modo, lo reportamos, pero podríamos intentar continuar si asumimos
    // que arrastrar la imagen fuerza el modo (a veces pasa en UI modernas).
    log({
      sceneNumber,
      step: 'No se encontró el botón de Video, intentando forzar drop',
      kind: LogKinds.Info,
      level: LogLevels.Step,
    });
  }

  // 2. Preparar el archivo a partir del base64
  if (!imageBase64 || !imageName) {
    await reportSceneFailed(
      sceneNumber,
      'Imagen de referencia requerida para video.',
      VIDEO_SCENE_RETRY_DELAY_MS
    );
    return;
  }
  const file = await base64ToFile(imageBase64, imageName);

  // 3. Inyectar prompt + archivo
  console.log(`[OmniFlow] 🎬 Escena ${sceneNumber}: Iniciando inyección de imagen y texto.`);
  const filled = await fillSlateComposer(composer, prompt, file);
  if (!filled) {
    console.error(
      `[OmniFlow] ❌ Escena ${sceneNumber}: Falló la inyección. La validación no encontró la imagen. Abortando envío para ahorrar créditos.`
    );
    await reportSceneFailed(
      sceneNumber,
      'Validación de seguridad fallida: la imagen no se adjuntó al chat.',
      VIDEO_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  console.log(
    `[OmniFlow] ✅ Escena yuo ${sceneNumber}: Inyección y validación exitosas. Procediendo a enviar.`
  );

  // 4. Enviar
  await sleep(3000);
  const submitted = await submitPrompt(composer);
  if (!submitted) {
    await reportSceneFailed(
      sceneNumber,
      'No se pudo hacer clic en el botón de enviar.',
      VIDEO_SCENE_RETRY_DELAY_MS
    );
    return;
  }

  const beforeIds = getMediaTileIds();

  // 5. Esperar resultado
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    if (aborted) return;

    log({
      sceneNumber,
      step: 'Esperando video (puede tardar varios minutos)',
      kind: LogKinds.Info,
      level: LogLevels.Step,
      attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
      cooldownMs: 240 * MEDIA_POLL_INTERVAL_MS,
    });

    const result = await waitForNewMedia(beforeIds, true);

    if (result.status === MediaPollStatuses.Aborted) return;
    if (result.status === MediaPollStatuses.Crashed) {
      log({
        sceneNumber,
        step: 'La página de Google Flow crasheó, saltando escena',
        kind: LogKinds.Error,
        level: LogLevels.Step,
      });
      await reportSceneFailed(sceneNumber, 'La página crasheó.', VIDEO_SCENE_RETRY_DELAY_MS);
      return;
    }

    if (result.status === MediaPollStatuses.Timeout) {
      if (attempt >= MAX_GENERATION_ATTEMPTS) {
        log({
          sceneNumber,
          step: 'Tiempo agotado, saltando escena',
          kind: LogKinds.Error,
          level: LogLevels.Step,
        });
        await reportSceneFailed(
          sceneNumber,
          'Tiempo agotado esperando el video.',
          VIDEO_SCENE_RETRY_DELAY_MS
        );
        return;
      }
      log({
        sceneNumber,
        step: 'Tiempo agotado, reintentando',
        kind: LogKinds.Retry,
        level: LogLevels.Step,
        attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
        cooldownMs: GENERATION_RETRY_DELAY_MS,
      });
      await sleepAbortable(GENERATION_RETRY_DELAY_MS);
      if (aborted) return;

      const refilled = await fillSlateComposer(composer, prompt, file);
      const resubmitted = refilled && (await submitPrompt(composer));
      if (!resubmitted) {
        log({
          sceneNumber,
          step: 'No se pudo reintentar, saltando escena',
          kind: LogKinds.Error,
          level: LogLevels.Step,
        });
        await reportSceneFailed(
          sceneNumber,
          'No se pudo reintentar el envío.',
          VIDEO_SCENE_RETRY_DELAY_MS
        );
        return;
      }
      continue;
    }

    // success
    log({
      sceneNumber,
      step: 'Video listo, descargando',
      kind: LogKinds.Success,
      level: LogLevels.Step,
    });

    const finalUrls = await Promise.all(
      result.urls.map(async (url) => {
        if (!url.startsWith('blob:')) return url;
        try {
          return await blobUrlToDataUrl(url);
        } catch {
          // Fallback
          return url;
        }
      })
    );

    await browser.runtime.sendMessage({
      action: Actions.DownloadMediaDirect,
      urls: finalUrls,
      sceneNumber,
    });
    return;
  }
}
