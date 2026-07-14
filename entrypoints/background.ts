import { Actions, SceneStatuses, BatchModes, LogKinds } from '../lib/types';
import { Alarms } from '../lib/constants';
import type {
  PendingWrite,
  SceneStatus,
  BatchStatus,
  SceneInput,
  BatchMode,
  ExtensionMessage,
  FillPromptMessage,
  LogKind,
} from '../lib/types';

interface BatchState {
  active: boolean;
  mode: BatchMode;
  projectName: string;
  scenes: SceneInput[];
  allSceneNumbers: number[];
  currentIndex: number;
  sceneStatuses: Record<number, SceneStatus>;
  tabId: number;
  pendingWrite: PendingWrite | null;
}

const STORAGE_KEY = 'batch';

// MV3 service workers unload after ~30s idle and wipe module state. A scene
// can take well over a minute to generate, so `batch` must survive that gap —
// it's persisted to session storage and reloaded on every cold start.
let batch: BatchState | null = null;
let popupTabId: number | null = null;

const batchLoaded = browser.storage.session.get(STORAGE_KEY).then((stored) => {
  batch = (stored[STORAGE_KEY] as BatchState | undefined) ?? null;
});

async function persistBatch() {
  await browser.storage.session.set({ [STORAGE_KEY]: batch });
}

// Step-level markers only (current step, retry N/max, cooldown before the
// next retry or scene). Structured, not free text — see LogMessage. Forwarded
// to the popup so it's visible without opening the service worker's own
// DevTools console.
function log(update: {
  sceneNumber?: number;
  step: string;
  kind: LogKind;
  attempt?: { current: number; max: number };
  cooldownMs?: number;
}) {
  console.debug('[vibes-ext:bg]', update);
  browser.runtime.sendMessage({ action: Actions.Log, ...update }).catch(() => {});
}

async function ensurePopupTab() {
  if (popupTabId !== null) {
    try {
      await browser.tabs.get(popupTabId);
      return;
    } catch {
      popupTabId = null;
    }
  }
  const popupUrl = browser.runtime.getURL('/popup.html');
  const tab = await browser.tabs.create({ url: popupUrl, active: false });
  popupTabId = tab.id ?? null;
}

function getStatus(): BatchStatus | null {
  if (!batch) return null;
  return {
    active: batch.active,
    mode: batch.mode,
    projectName: batch.projectName,
    currentIndex: batch.currentIndex,
    totalScenes: batch.allSceneNumbers.length,
    sceneNumbers: batch.allSceneNumbers,
    sceneStatuses: { ...batch.sceneStatuses },
    pendingWrite: batch.pendingWrite,
  };
}

function broadcastStatus() {
  browser.runtime.sendMessage({ action: Actions.BatchStatus, status: getStatus() }).catch(() => {});
}

async function resetSceneTimeout(delayInMinutes: number) {
  await browser.alarms.clear(Alarms.SceneTimeout);
  browser.alarms.create(Alarms.SceneTimeout, { delayInMinutes });
}

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

async function processScene(index: number) {
  if (!batch || !batch.active) return;
  if (index >= batch.scenes.length) {
    batch.active = false;
    await persistBatch();
    broadcastStatus();
    return;
  }

  batch.currentIndex = index;
  const scene = batch.scenes[index];
  batch.sceneStatuses[scene.sceneNumber] = SceneStatuses.Processing;
  await persistBatch();
  broadcastStatus();

  log({
    sceneNumber: scene.sceneNumber,
    step: `Enviando prompt (escena ${index + 1}/${batch.scenes.length})`,
    kind: LogKinds.Info,
  });

  // The content script's own explicit success/failure messages are what
  // normally end a scene — this is just a fallback in case it hangs
  // silently. Covers everything up to detecting the finished media batch
  // (mode switch, start frame upload for video, prompt fill, generation
  // polling).
  await resetSceneTimeout(5);

  try {
    const response = await browser.tabs.sendMessage(batch.tabId, buildFillPromptMessage(scene));

    if (!response?.success) {
      throw new Error(response?.error ?? 'fill_prompt failed');
    }
  } catch {
    await browser.alarms.clear(Alarms.SceneTimeout);
    if (batch) {
      batch.sceneStatuses[scene.sceneNumber] = SceneStatuses.Error;
      await persistBatch();
      broadcastStatus();
      // Video scenes hit vibes.ai with two API calls (upload + generate)
      // instead of one — chaining them back-to-back across scenes is what
      // triggers the site's own rate limiting, so give video extra room.
      const retryDelayMs = batch.mode === BatchModes.Video ? 12000 : 4500;
      const nextIdx = index + 1;
      log({
        sceneNumber: scene.sceneNumber,
        step: 'No se pudo enviar el prompt, saltando escena',
        kind: LogKinds.Error,
        cooldownMs: retryDelayMs,
      });
      setTimeout(() => {
        if (batch?.active) processScene(nextIdx);
      }, retryDelayMs);
    }
  }
}

async function advanceAfterPendingWrite(sceneNumber: number) {
  if (!batch) return;
  batch.pendingWrite = null;
  batch.sceneStatuses[sceneNumber] = SceneStatuses.Done;
  await persistBatch();
  broadcastStatus();
  const nextIdx = batch.currentIndex + 1;
  const nextDelayMs = batch.mode === BatchModes.Video ? 12000 : 4000;
  log({
    sceneNumber,
    step: 'Escena lista, siguiente en breve',
    kind: LogKinds.Success,
    cooldownMs: nextDelayMs,
  });
  setTimeout(() => {
    if (batch?.active) processScene(nextIdx);
  }, nextDelayMs);
}

// Shared by the SceneTimeout alarm (silent stall) and the content script's
// explicit "Couldn't generate" detection — either way, this scene is dead,
// mark it and move on rather than sitting on it for the rest of the timeout.
async function markSceneErrorAndAdvance(sceneNumber: number) {
  if (!batch) return;
  log({ sceneNumber, step: 'Escena marcada como error, avanzando', kind: LogKinds.Error });
  batch.sceneStatuses[sceneNumber] = SceneStatuses.Error;
  batch.pendingWrite = null;
  await persistBatch();
  broadcastStatus();
  await browser.alarms.clear(Alarms.SceneTimeout);
  const nextIdx = batch.currentIndex + 1;
  setTimeout(() => {
    if (batch?.active) processScene(nextIdx);
  }, 1000);
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(async (message: ExtensionMessage) => {
    await batchLoaded;

    if (message.action === Actions.StartBatch) {
      const preCompleted = message.preCompletedSceneNumbers;
      const initialStatuses: Record<number, SceneStatus> = {};
      for (const n of preCompleted) initialStatuses[n] = SceneStatuses.Done;

      batch = {
        active: true,
        mode: message.mode,
        projectName: message.projectName,
        scenes: message.scenes,
        allSceneNumbers: [...preCompleted, ...message.scenes.map((s) => s.sceneNumber)].sort(
          (a, b) => a - b
        ),
        currentIndex: 0,
        sceneStatuses: initialStatuses,
        tabId: message.tabId,
        pendingWrite: null,
      };
      await persistBatch();
      ensurePopupTab().then(() => processScene(0));
      return { ok: true };
    }

    if (message.action === Actions.StopBatch) {
      if (batch) {
        batch.active = false;
        await persistBatch();
        // `batch.active = false` only stops the NEXT scene from being
        // queued — the content script's currently-running scene (clicks,
        // polling, retry waits) has no way to know about that on its own.
        // Message the tab directly so it can abort what it's doing too.
        browser.tabs.sendMessage(batch.tabId, { action: Actions.StopBatch }).catch(() => {});
      }
      await browser.alarms.clear(Alarms.SceneTimeout);
      broadcastStatus();
      return { ok: true };
    }

    if (message.action === Actions.GetBatchStatus) {
      return getStatus();
    }

    if (message.action === Actions.DownloadMediaDirect) {
      const { urls, sceneNumber } = message;
      await resetSceneTimeout(2);
      if (batch && batch.active) {
        batch.pendingWrite = { mode: batch.mode, sceneNumber, urls };
        await persistBatch();
        broadcastStatus();
      }
      return;
    }

    if (message.action === Actions.WriteDone) {
      const { sceneNumber } = message;
      if (batch?.pendingWrite?.sceneNumber === sceneNumber) {
        await browser.alarms.clear(Alarms.SceneTimeout);
        await advanceAfterPendingWrite(sceneNumber);
      }
      return;
    }

    if (message.action === Actions.SceneFailed) {
      const { sceneNumber } = message;
      if (batch?.active && batch.sceneStatuses[sceneNumber] === SceneStatuses.Processing) {
        await markSceneErrorAndAdvance(sceneNumber);
      }
      return;
    }

    return;
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    await batchLoaded;
    if (alarm.name === Alarms.SceneTimeout && batch?.active) {
      const scene = batch.scenes[batch.currentIndex];
      if (scene && batch.sceneStatuses[scene.sceneNumber] === SceneStatuses.Processing) {
        await markSceneErrorAndAdvance(scene.sceneNumber);
      }
    }
  });
});
