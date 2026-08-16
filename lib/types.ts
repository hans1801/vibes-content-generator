export const Actions = {
  SendPrompt: 'send_prompt',
  StartBatch: 'start_batch',
  StopBatch: 'stop_batch',
  GetBatchStatus: 'get_batch_status',
  DownloadMediaDirect: 'download_media_direct',
  WriteDone: 'write_done',
  SceneFailed: 'scene_failed',
  BatchStatus: 'batch_status',
  Log: 'log',
  NativeClick: 'native_click',
  NativeType: 'native_type',
} as const;

export const BatchModes = {
  Video: 'video',
  Image: 'image',
} as const;

export type BatchMode = (typeof BatchModes)[keyof typeof BatchModes];

export const SceneStatuses = {
  Processing: 'processing',
  Done: 'done',
  Error: 'error',
} as const;

export type SceneStatus = (typeof SceneStatuses)[keyof typeof SceneStatuses];

// Which of the two supported sites a batch is running against — needed
// because some post-processing (the vibes.ai watermark blur) only applies
// to one of them. Decided once in the popup (it has the active tab's URL)
// and carried through StartBatch → BatchState → PendingWrite.
export const BatchSites = {
  Vibes: 'vibes',
  Flow: 'flow',
} as const;

export type BatchSite = (typeof BatchSites)[keyof typeof BatchSites];

// Video scenes carry the already-generated reference image (base64) as the
// start frame — video generation always animates a prior image.
export type SceneInput =
  | { kind: typeof BatchModes.Image; sceneNumber: number; imagePrompt: string }
  | {
      kind: typeof BatchModes.Video;
      sceneNumber: number;
      imageBase64: string;
      imageName: string;
      videoPrompt: string;
    };

// Both image and video generations produce a variable-length batch of urls
// (Vibes returns 4, Google Flow returns 1+). urls[] covers both.
export interface PendingWrite {
  mode: BatchMode;
  site: BatchSite;
  sceneNumber: number;
  urls: string[];
}

export interface BatchStatus {
  active: boolean;
  mode: BatchMode;
  projectName: string;
  currentIndex: number;
  totalScenes: number;
  sceneNumbers: number[];
  sceneStatuses: Record<number, SceneStatus>;
  pendingWrite: PendingWrite | null;
  // Current scene's log tree (see LogLevels), persisted across popup reopens.
  logStack: LogEntry[];
}

// ── Message contracts ─────────────────────────────────────────────────────────

export interface SendPromptMessage {
  action: typeof Actions.SendPrompt;
  prompt: string;
  mediaType: BatchMode;
  imageBase64: string | null;
  imageName: string | null;
  sceneNumber: number;
}

export interface StartBatchMessage {
  action: typeof Actions.StartBatch;
  projectName: string;
  scenes: SceneInput[];
  tabId: number;
  preCompletedSceneNumbers: number[];
  mode: BatchMode;
  site: BatchSite;
}

export interface StopBatchMessage {
  action: typeof Actions.StopBatch;
}

export interface GetBatchStatusMessage {
  action: typeof Actions.GetBatchStatus;
}

export interface DownloadMediaDirectMessage {
  action: typeof Actions.DownloadMediaDirect;
  urls: string[];
  sceneNumber: number;
}

export interface WriteDoneMessage {
  action: typeof Actions.WriteDone;
  sceneNumber: number;
}

export interface SceneFailedMessage {
  action: typeof Actions.SceneFailed;
  sceneNumber: number;
  // Human-readable cause, shown in the log step instead of the generic
  // fallback text. Optional — the SceneTimeout alarm path has no content
  // script to ask, so it has no reason to give.
  reason?: string;
  // How long to wait before advancing to the next scene — content scripts
  // know their own site's rate-limit behavior (see GENERATION_RETRY_DELAY_MS
  // / UPLOAD_RETRY_DELAY_MS). Falls back to a short generic delay when unset.
  retryAfterMs?: number;
}

export interface BatchStatusMessage {
  action: typeof Actions.BatchStatus;
  status: BatchStatus | null;
}

export const LogKinds = {
  Info: 'info',
  Retry: 'retry',
  Success: 'success',
  Error: 'error',
} as const;

export type LogKind = (typeof LogKinds)[keyof typeof LogKinds];

// Depth in the current scene's step tree (0 = scene, deeper = nested step).
export const LogLevels = {
  Scene: 0,
  Mode: 1,
  Step: 2,
  Detail: 3,
} as const;

export type LogLevel = (typeof LogLevels)[keyof typeof LogLevels];

// Step-level progress markers forwarded from content scripts so the popup
// can show a live status without requiring its own DevTools console.
export interface LogMessage {
  action: typeof Actions.Log;
  sceneNumber: number;
  step: string;
  kind: LogKind;
  level: LogLevel;
  attempt?: { current: number; max: number };
  cooldownMs?: number;
}

// What background.ts and each content script pass to their local log()
// helper — same shape as LogMessage minus the action tag, which log() adds.
export type LogUpdate = Omit<LogMessage, 'action'>;

// LogUpdate + receivedAt, as persisted by batchStore.
export type LogEntry = LogUpdate & { receivedAt: number };

export interface NativeClickMessage {
  action: typeof Actions.NativeClick;
  x: number;
  y: number;
}

export interface NativeTypeMessage {
  action: typeof Actions.NativeType;
  text: string;
}

export type ExtensionMessage =
  | SendPromptMessage
  | StartBatchMessage
  | StopBatchMessage
  | GetBatchStatusMessage
  | DownloadMediaDirectMessage
  | WriteDoneMessage
  | SceneFailedMessage
  | BatchStatusMessage
  | LogMessage
  | NativeClickMessage
  | NativeTypeMessage;
