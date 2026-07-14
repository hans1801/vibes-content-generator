export const Actions = {
  FillPrompt: 'fill_prompt',
  StartBatch: 'start_batch',
  StopBatch: 'stop_batch',
  GetBatchStatus: 'get_batch_status',
  DownloadMediaDirect: 'download_media_direct',
  WriteDone: 'write_done',
  SceneFailed: 'scene_failed',
  BatchStatus: 'batch_status',
  DebugLog: 'debug_log',
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

// Video scenes carry the already-generated reference image (base64) as the
// start frame — video generation on vibes.ai always animates a prior image.
export type SceneInput =
  | { kind: typeof BatchModes.Image; sceneNumber: number; imagePrompt: string }
  | {
      kind: typeof BatchModes.Video;
      sceneNumber: number;
      imageBase64: string;
      imageName: string;
      videoPrompt: string;
    };

// Both image and video generations on vibes.ai produce a 4-item batch, so a
// single shape (urls[]) covers both — no need for a per-mode union here.
export interface PendingWrite {
  mode: BatchMode;
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
}

// ── Message contracts ─────────────────────────────────────────────────────────

export interface FillPromptMessage {
  action: typeof Actions.FillPrompt;
  prompt: string;
  mediaType: BatchMode;
  imageBase64: string | null;
  imageName: string | null;
  sceneNumber?: number;
}

export interface StartBatchMessage {
  action: typeof Actions.StartBatch;
  projectName: string;
  scenes: SceneInput[];
  tabId: number;
  preCompletedSceneNumbers: number[];
  mode: BatchMode;
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

// vibes.ai shows an inline "Couldn't generate" card instead of a thumbnail
// when a generation errors out — sent so the batch can skip to the next
// scene right away instead of waiting for the full timeout.
export interface SceneFailedMessage {
  action: typeof Actions.SceneFailed;
  sceneNumber: number;
}

export interface BatchStatusMessage {
  action: typeof Actions.BatchStatus;
  status: BatchStatus | null;
}

// The content script runs on the page, invisible to DevTools unless you know
// to inspect that specific tab. Piping its debug output through here lets
// the popup show it directly, no console-hunting required.
export interface DebugLogMessage {
  action: typeof Actions.DebugLog;
  text: string;
}

export type ExtensionMessage =
  | FillPromptMessage
  | StartBatchMessage
  | StopBatchMessage
  | GetBatchStatusMessage
  | DownloadMediaDirectMessage
  | WriteDoneMessage
  | SceneFailedMessage
  | BatchStatusMessage
  | DebugLogMessage;

// ── Response contracts ────────────────────────────────────────────────────────

export interface ContentResponse {
  success: boolean;
  error?: string;
  message?: string;
}
