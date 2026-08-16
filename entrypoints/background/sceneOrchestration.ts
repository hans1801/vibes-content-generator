import { Actions, SceneStatuses, BatchModes, LogKinds, LogLevels } from '../../lib/types';
import { Alarms } from '../../lib/constants';
import type { SceneInput, SendPromptMessage, LogUpdate } from '../../lib/types';
import { batchStore } from './batchStore';

// ── Logging ───────────────────────────────────────────────────────────────────

function log(update: LogUpdate) {
  browser.runtime.sendMessage({ action: Actions.Log, ...update }).catch(() => {});
  // Doesn't round-trip through background's own onMessage, so persist directly.
  void batchStore.pushLog(update);
}

// ── Message construction ──────────────────────────────────────────────────────

function buildSendPromptMessage(scene: SceneInput): SendPromptMessage {
  if (scene.kind === BatchModes.Image) {
    return {
      action: Actions.SendPrompt,
      prompt: scene.imagePrompt,
      mediaType: BatchModes.Image,
      imageBase64: null,
      imageName: null,
      sceneNumber: scene.sceneNumber,
    };
  }
  return {
    action: Actions.SendPrompt,
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
    level: LogLevels.Scene,
  });

  // Silent-hang fallback — the content script's own messages normally end
  // the scene before this fires.
  await resetSceneTimeout(5);

  // A rejection here means the message itself couldn't be delivered (tab
  // closed) — real outcomes arrive later via their own messages.
  try {
    await browser.tabs.sendMessage(batch.tabId, buildSendPromptMessage(scene));
  } catch (err) {
    await browser.alarms.clear(Alarms.SceneTimeout);
    if (!batchStore.batch) return;

    // Video needs more breathing room before the next scene (2 API calls).
    const retryDelayMs = batch.mode === BatchModes.Video ? 12000 : 4500;
    const nextIdx = index + 1;

    await batchStore.setSceneStatus(scene.sceneNumber, SceneStatuses.Error);
    batchStore.broadcastStatus();

    log({
      sceneNumber: scene.sceneNumber,
      step: err instanceof Error ? err.message : 'No se pudo contactar la pestaña.',
      kind: LogKinds.Error,
      level: LogLevels.Scene,
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
    log({
      sceneNumber,
      step,
      kind: errorCount > 0 ? LogKinds.Error : LogKinds.Success,
      level: LogLevels.Scene,
    });
    await runBatchSceneFrom(nextIdx);
    return;
  }

  const nextDelayMs = batch.mode === BatchModes.Video ? 12000 : 4000;
  log({
    sceneNumber,
    step: 'Escena lista, siguiente en breve',
    kind: LogKinds.Success,
    level: LogLevels.Scene,
    cooldownMs: nextDelayMs,
  });
  setTimeout(() => {
    if (batchStore.batch?.active) runBatchSceneFrom(nextIdx);
  }, nextDelayMs);
}

// `reason`/`retryAfterMs` come from SceneFailed; the SceneTimeout alarm
// calls this with neither, falling back to the generic text/delay.
export async function markSceneErrorAndAdvance(
  sceneNumber: number,
  reason?: string,
  retryAfterMs?: number
) {
  const { batch } = batchStore;
  if (!batch) return;
  log({
    sceneNumber,
    step: reason ?? 'Escena marcada como error, avanzando',
    kind: LogKinds.Error,
    level: LogLevels.Scene,
  });
  await batchStore.setSceneStatus(sceneNumber, SceneStatuses.Error);
  await batchStore.clearPendingWrite();
  batchStore.broadcastStatus();
  await browser.alarms.clear(Alarms.SceneTimeout);
  const nextIdx = batch.currentIndex + 1;
  setTimeout(() => {
    if (batchStore.batch?.active) runBatchSceneFrom(nextIdx);
  }, retryAfterMs ?? 1000);
}
