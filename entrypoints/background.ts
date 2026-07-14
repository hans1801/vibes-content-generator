import { Actions, SceneStatuses, BatchModes } from '../lib/types';
import { Alarms } from '../lib/constants';
import type {
  PendingWrite,
  SceneStatus,
  BatchStatus,
  SceneInput,
  BatchMode,
  ExtensionMessage,
  FillPromptMessage,
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

  // This just needs to outlast the content script's own worst-case retry
  // chain (up to 3 generation attempts x ~5min poll each, plus for video up
  // to 3 upload attempts x ~2min each) so this watchdog doesn't fire and
  // race with legitimate in-progress retries — the content script's own
  // explicit success/failure messages are what normally end a scene.
  await resetSceneTimeout(batch.mode === BatchModes.Video ? 25 : 18);

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
      const retryDelayMs = batch.mode === BatchModes.Video ? 8000 : 3000;
      const nextIdx = index + 1;
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
  const nextDelayMs = batch.mode === BatchModes.Video ? 8000 : 2500;
  setTimeout(() => {
    if (batch?.active) processScene(nextIdx);
  }, nextDelayMs);
}

// Shared by the SceneTimeout alarm (silent stall) and the content script's
// explicit "Couldn't generate" detection — either way, this scene is dead,
// mark it and move on rather than sitting on it for the rest of the timeout.
async function markSceneErrorAndAdvance(sceneNumber: number) {
  if (!batch) return;
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
