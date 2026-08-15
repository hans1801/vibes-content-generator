import { Actions, SceneStatuses, BatchModes, LogKinds } from '../../lib/types';
import { Alarms } from '../../lib/constants';
import type { SceneInput, FillPromptMessage, LogUpdate } from '../../lib/types';
import { batchStore } from './batchStore';

// ── Logging ───────────────────────────────────────────────────────────────────

function log(update: LogUpdate) {
  browser.runtime.sendMessage({ action: Actions.Log, ...update }).catch(() => {});
}

// ── Message construction ──────────────────────────────────────────────────────

function buildFillPromptMessage(scene: SceneInput): FillPromptMessage {
  if (scene.kind === BatchModes.Image) {
    return {
      action: Actions.FillPrompt,
      prompt: scene.imagePrompt,
      mediaType: BatchModes.Image,
      imageBase64: null,
      imageName: null,
      sceneNumber: scene.sceneNumber,
    };
  }
  return {
    action: Actions.FillPrompt,
    prompt: scene.videoPrompt,
    mediaType: BatchModes.Video,
    imageBase64: scene.imageBase64,
    imageName: scene.imageName,
    sceneNumber: scene.sceneNumber,
  };
}

export async function resetSceneTimeout(delayInMinutes: number) {
  await browser.alarms.clear(Alarms.SceneTimeout);
  browser.alarms.create(Alarms.SceneTimeout, { delayInMinutes });
}

// ── Scene orchestration ───────────────────────────────────────────────────────

export async function runBatchSceneFrom(index: number) {
  const { batch } = batchStore;
  if (!batch || !batch.active) return;
  if (index >= batch.scenes.length) {
    await batchStore.stop();
    batchStore.broadcastStatus();
    return;
  }

  await batchStore.advanceTo(index);
  const scene = batch.scenes[index];
  await batchStore.setSceneStatus(scene.sceneNumber, SceneStatuses.Processing);
  batchStore.broadcastStatus();

  log({
    sceneNumber: scene.sceneNumber,
    step: `Enviando prompt (escena ${index + 1}/${batch.scenes.length})`,
    kind: LogKinds.Info,
  });

  // Scene timeout acts as a silent-hang fallback — the content script's
  // explicit success/failure messages normally end a scene before this fires.
  await resetSceneTimeout(5);

  try {
    const response = await browser.tabs.sendMessage(batch.tabId, buildFillPromptMessage(scene));
    if (!response?.success) throw new Error(response?.error ?? 'fill_prompt failed');
  } catch (err) {
    await browser.alarms.clear(Alarms.SceneTimeout);
    if (!batchStore.batch) return;

    await batchStore.setSceneStatus(scene.sceneNumber, SceneStatuses.Error);
    batchStore.broadcastStatus();

    // Video scenes require two API calls (upload + generate), which hits rate
    // limits faster — give them more breathing room before the next scene.
    // TODO: this only accounts for mode, not site — google.content.ts and
    // vibes.content.ts already have their own per-site rate-limit delays
    // (GENERATION_RETRY_DELAY_MS, UPLOAD_RETRY_DELAY_MS). Consider adding an
    // optional `retryAfterMs` to ContentResponse so each site can suggest its
    // own cooldown per failure, with this as just the fallback default.
    const retryDelayMs = batch.mode === BatchModes.Video ? 12000 : 4500;
    const nextIdx = index + 1;

    log({
      sceneNumber: scene.sceneNumber,
      step: err instanceof Error ? err.message : 'Error desconocido al inyectar',
      kind: LogKinds.Error,
      cooldownMs: retryDelayMs,
    });

    setTimeout(() => {
      if (batchStore.batch?.active) runBatchSceneFrom(nextIdx);
    }, retryDelayMs);
  }
}

export async function advanceAfterPendingWrite(sceneNumber: number) {
  const { batch } = batchStore;
  if (!batch) return;
  await batchStore.clearPendingWrite();
  await batchStore.setSceneStatus(sceneNumber, SceneStatuses.Done);
  batchStore.broadcastStatus();

  const nextIdx = batch.currentIndex + 1;
  const isLastScene = nextIdx >= batch.scenes.length;

  if (isLastScene) {
    const errorCount = Object.values(batch.sceneStatuses).filter(
      (s) => s === SceneStatuses.Error
    ).length;
    const step =
      errorCount > 0
        ? `Batch completo, ${errorCount} escena(s) con error`
        : 'Batch completo, sin errores';
    log({ sceneNumber, step, kind: errorCount > 0 ? LogKinds.Error : LogKinds.Success });
    await runBatchSceneFrom(nextIdx);
    return;
  }

  const nextDelayMs = batch.mode === BatchModes.Video ? 12000 : 4000;
  log({
    sceneNumber,
    step: 'Escena lista, siguiente en breve',
    kind: LogKinds.Success,
    cooldownMs: nextDelayMs,
  });
  setTimeout(() => {
    if (batchStore.batch?.active) runBatchSceneFrom(nextIdx);
  }, nextDelayMs);
}

export async function markSceneErrorAndAdvance(sceneNumber: number) {
  const { batch } = batchStore;
  if (!batch) return;
  log({ sceneNumber, step: 'Escena marcada como error, avanzando', kind: LogKinds.Error });
  await batchStore.setSceneStatus(sceneNumber, SceneStatuses.Error);
  await batchStore.clearPendingWrite();
  batchStore.broadcastStatus();
  await browser.alarms.clear(Alarms.SceneTimeout);
  const nextIdx = batch.currentIndex + 1;
  setTimeout(() => {
    if (batchStore.batch?.active) runBatchSceneFrom(nextIdx);
  }, 1000);
}
