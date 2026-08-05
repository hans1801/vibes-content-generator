export const Actions = {
  FillPrompt: 'fill_prompt',
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

export interface SceneFailedMessage {
  action: typeof Actions.SceneFailed;
  sceneNumber: number;
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

// Step-level progress markers forwarded from content scripts so the popup
// can show a live status without requiring its own DevTools console.
export interface LogMessage {
  action: typeof Actions.Log;
  sceneNumber?: number;
  step: string;
  kind: LogKind;
  attempt?: { current: number; max: number };
  cooldownMs?: number;
}

export interface NativeClickMessage {
  action: typeof Actions.NativeClick;
  x: number;
  y: number;
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
  | LogMessage
  | NativeClickMessage;

export interface ContentResponse {
  success: boolean;
  error?: string;
  message?: string;
}
