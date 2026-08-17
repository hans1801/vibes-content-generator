import { Actions } from '../../lib/types';
import type {
  PendingWrite,
  SceneStatus,
  BatchStatus,
  SceneInput,
  BatchMode,
  BatchSite,
  LogUpdate,
  LogEntry,
} from '../../lib/types';

interface BatchState {
  active: boolean;
  mode: BatchMode;
  site: BatchSite;
  projectName: string;
  scenes: SceneInput[];
  allSceneNumbers: number[];
  currentIndex: number;
  sceneStatuses: Record<number, SceneStatus>;
  tabId: number;
  pendingWrite: PendingWrite | null;
  logStack: LogEntry[];
  // Internal only — tracks scene changes for pushLog's reset check.
  lastLogSceneNumber: number | null;
}

const STORAGE_KEY = 'batch';

class BatchStore {
  // Persisted so it survives MV3 service worker restarts (~30s idle).
  batch: BatchState | null = null;

  // Only ensurePopupTab() touches this, so it lives private next to it.
  private popupTabId: number | null = null;

  // Awaited before touching `batch` — guards against a cold-started worker
  // acting before storage finishes restoring it.
  readonly loaded: Promise<void>;

  // Not exported — batchStore below is the only instance.
  constructor() {
    this.loaded = browser.storage.local.get(STORAGE_KEY).then((stored) => {
      this.batch = (stored[STORAGE_KEY] as BatchState | undefined) ?? null;
    });
  }

  // Only place allowed to replace the whole batch object.
  public async start(state: BatchState) {
    this.batch = state;
    await this.persist();
    await this.ensurePopupTab();
  }

  public async setPendingWrite(sceneNumber: number, urls: string[]) {
    if (!this.batch || !this.batch.active) return;
    this.batch.pendingWrite = {
      mode: this.batch.mode,
      site: this.batch.site,
      sceneNumber,
      urls,
    };
    await this.persist();
  }

  public async clearPendingWrite() {
    if (!this.batch) return;
    this.batch.pendingWrite = null;
    await this.persist();
  }

  public async setSceneStatus(sceneNumber: number, status: SceneStatus) {
    if (!this.batch) return;
    this.batch.sceneStatuses[sceneNumber] = status;
    await this.persist();
  }

  public async advanceTo(index: number) {
    if (!this.batch) return;
    this.batch.currentIndex = index;
    await this.persist();
  }

  public async stop() {
    if (!this.batch) return;
    this.batch.active = false;
    this.batch.logStack = [];
    this.batch.lastLogSceneNumber = null;
    await this.persist();
  }

  // Same collapsing-stack logic as StatusPanel, persisted so it survives popup close/reopen.
  public async pushLog(update: LogUpdate) {
    if (!this.batch) return;
    const entry: LogEntry = { ...update, receivedAt: Date.now() };
    const sameScene = this.batch.lastLogSceneNumber === update.sceneNumber;
    this.batch.lastLogSceneNumber = update.sceneNumber;
    const stack = sameScene ? this.batch.logStack.slice(0, entry.level) : [];
    stack[entry.level] = entry;
    this.batch.logStack = stack;
    await this.persist();
  }

  private async persist() {
    await browser.storage.local.set({ [STORAGE_KEY]: this.batch });
  }

  public getStatus(): BatchStatus | null {
    if (!this.batch) return null;
    return {
      active: this.batch.active,
      mode: this.batch.mode,
      projectName: this.batch.projectName,
      currentIndex: this.batch.currentIndex,
      totalScenes: this.batch.allSceneNumbers.length,
      sceneNumbers: this.batch.allSceneNumbers,
      sceneStatuses: { ...this.batch.sceneStatuses },
      pendingWrite: this.batch.pendingWrite,
      logStack: this.batch.logStack ?? [],
    };
  }

  public broadcastStatus() {
    browser.runtime
      .sendMessage({ action: Actions.BatchStatus, status: this.getStatus() })
      .catch(() => {});
  }

  // Creates (or reuses) a hidden tab running popup.html — stays alive with
  // File System Access permission even after the dropdown popup closes.
  private async ensurePopupTab() {
    if (this.popupTabId !== null) {
      try {
        await browser.tabs.get(this.popupTabId);
        return;
      } catch {
        this.popupTabId = null;
      }
    }
    const tab = await browser.tabs.create({
      url: browser.runtime.getURL('/popup.html'),
      active: false,
    });
    this.popupTabId = tab.id ?? null;
  }
}

// Single shared instance — every file imports this same object.
export const batchStore = new BatchStore();
