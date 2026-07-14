import { useState } from 'react';
import { Actions, SceneStatuses, BatchModes } from '../../../lib/types';
import type { BatchMode, BatchStatus, SceneInput, SceneStatus } from '../../../lib/types';
import { storeProjectHandle, fileToDataUrl } from '../utils';
import {
  ProjectDirs,
  ProjectFiles,
  SCENE_MEDIA_FOLDER_PATTERN,
  VIDEO_PROMPT_PREFIX,
  sceneRefImageName,
} from '../../../lib/constants';

declare function showDirectoryPicker(options?: {
  mode?: 'read' | 'readwrite';
}): Promise<FileSystemDirectoryHandle>;

// ── Types ────────────────────────────────────────────────────────────────────

interface ImagePrompt {
  subjects: { description: string; action: string }[];
  environment: string;
  lighting: string;
  composition: string;
  style: string;
}

interface SceneData {
  scene_number: number;
  image_prompt: ImagePrompt;
  video_prompt?: { motion: string; camera_movement: string };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const clean = (s?: string) => s?.trim() ?? '';

function buildImagePrompt(scene: SceneData): string {
  const { image_prompt: ip } = scene;
  const subjects = ip.subjects.map((s) => `${clean(s.description)} ${clean(s.action)}`).join(' ');
  return [subjects, ip.environment, ip.lighting, ip.composition, ip.style]
    .map(clean)
    .filter(Boolean)
    .join(' ');
}

function buildVideoPrompt(scene: SceneData): string {
  const vp = scene.video_prompt;
  if (!vp) return VIDEO_PROMPT_PREFIX;
  const strip = (s?: string) => clean(s).replace(/\.$/, '');
  return `${VIDEO_PROMPT_PREFIX} ${strip(vp.motion)} ${strip(vp.camera_movement)}`.trim();
}

function getPreCompleted(allScenes: SceneData[], pendingScenes: SceneData[]): number[] {
  const pendingNums = new Set(pendingScenes.map((s) => s.scene_number));
  return allScenes.map((s) => s.scene_number).filter((n) => !pendingNums.has(n));
}

async function readCompletedScenes(
  handle: FileSystemDirectoryHandle,
  dirName: string
): Promise<Set<number>> {
  const completed = new Set<number>();
  try {
    const dir = await handle.getDirectoryHandle(dirName);
    for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if ((entry as FileSystemHandle & { kind: string }).kind !== 'directory') continue;
      const m = name.match(SCENE_MEDIA_FOLDER_PATTERN);
      if (m) completed.add(parseInt(m[1]));
    }
  } catch {
    /* dir doesn't exist yet */
  }
  return completed;
}

async function validateSceneRefImages(
  projectHandle: FileSystemDirectoryHandle,
  scenes: SceneData[]
): Promise<number[]> {
  const missing: number[] = [];
  try {
    const imagesDir = await projectHandle.getDirectoryHandle(ProjectDirs.Images);
    await Promise.all(
      scenes.map(async (scene) => {
        try {
          await imagesDir.getFileHandle(sceneRefImageName(scene.scene_number));
        } catch {
          missing.push(scene.scene_number);
        }
      })
    );
  } catch {
    return scenes.map((s) => s.scene_number);
  }
  return missing;
}

async function buildVideoScenes(
  projectHandle: FileSystemDirectoryHandle,
  pendingScenes: SceneData[]
): Promise<SceneInput[]> {
  const imagesDir = await projectHandle.getDirectoryHandle(ProjectDirs.Images);
  return Promise.all(
    pendingScenes.map(async (scene) => {
      const file = await (
        await imagesDir.getFileHandle(sceneRefImageName(scene.scene_number))
      ).getFile();
      return {
        kind: BatchModes.Video,
        sceneNumber: scene.scene_number,
        imageBase64: await fileToDataUrl(file),
        imageName: sceneRefImageName(scene.scene_number),
        videoPrompt: buildVideoPrompt(scene),
      } satisfies SceneInput;
    })
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

const SCENE_ICONS: Record<string, string> = {
  [SceneStatuses.Processing]: '⏳',
  [SceneStatuses.Done]: '✓',
  [SceneStatuses.Error]: '✗',
};

function StatusSceneGrid({
  sceneNumbers,
  sceneStatuses,
}: {
  sceneNumbers: number[];
  sceneStatuses: Record<number, SceneStatus>;
}) {
  return (
    <div className="scene-grid">
      {sceneNumbers.map((n) => (
        <div
          key={n}
          className={`scene-cell scene-cell--${sceneStatuses[n] ?? 'pending'}`}
          title={`Escena ${String(n).padStart(4, '0')}`}
        >
          {SCENE_ICONS[sceneStatuses[n]] ?? '·'}
        </div>
      ))}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

interface Props {
  batchStatus: BatchStatus | null;
  grantedHandleRef: { current: FileSystemDirectoryHandle | null };
}

export default function BatchMode({ batchStatus, grantedHandleRef }: Props) {
  const [projectHandle, setProjectHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [projectName, setProjectName] = useState('');
  const [batchScenes, setBatchScenes] = useState<SceneData[]>([]);
  const [completedScenes, setCompletedScenes] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [batchType, setBatchType] = useState<BatchMode>(BatchModes.Image);

  const isBatchActive = batchStatus?.active === true;
  const doneCount = batchStatus
    ? Object.values(batchStatus.sceneStatuses).filter((s) => s === SceneStatuses.Done).length
    : 0;
  const pendingScenes = batchScenes.filter((s) => !completedScenes.has(s.scene_number));

  const readCompleted = (handle: FileSystemDirectoryHandle, type: BatchMode) =>
    readCompletedScenes(
      handle,
      type === BatchModes.Image ? ProjectDirs.Images : ProjectDirs.Videos
    );

  const selectFolder = async () => {
    try {
      const handle = await showDirectoryPicker({ mode: 'readwrite' });
      setProjectHandle(handle);
      setProjectName(handle.name);
      grantedHandleRef.current = handle;
      await storeProjectHandle(handle);
      setStatusMsg('');

      const scriptFile = await (await handle.getFileHandle(ProjectFiles.Script)).getFile();
      const { scenes } = JSON.parse(await scriptFile.text()) as { scenes: SceneData[] };
      setBatchScenes(scenes);
      setCompletedScenes(await readCompleted(handle, batchType));
    } catch (err: unknown) {
      if ((err as DOMException)?.name !== 'AbortError') {
        setStatusMsg('No se pudo leer la carpeta del proyecto.');
      }
    }
  };

  const switchBatchType = async (type: BatchMode) => {
    setBatchType(type);
    if (projectHandle) setCompletedScenes(await readCompleted(projectHandle, type));
  };

  const startBatch = async () => {
    if (!projectHandle || pendingScenes.length === 0) return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatusMsg('Abre vibes.ai en la pestaña activa primero.');
      return;
    }

    if (batchType === BatchModes.Video) {
      const missing = await validateSceneRefImages(projectHandle, pendingScenes);
      if (missing.length > 0) {
        setStatusMsg(
          `Faltan imágenes de referencia para escenas: ${missing.sort((a, b) => a - b).join(', ')}. Genera las imágenes primero.`
        );
        return;
      }
    }

    setLoading(true);
    setStatusMsg(
      batchType === BatchModes.Image
        ? 'Iniciando batch de imágenes...'
        : 'Cargando imagen de referencia...'
    );
    try {
      const scenes: SceneInput[] =
        batchType === BatchModes.Image
          ? pendingScenes.map((s) => ({
              kind: BatchModes.Image,
              sceneNumber: s.scene_number,
              imagePrompt: buildImagePrompt(s),
            }))
          : await buildVideoScenes(projectHandle, pendingScenes);

      await browser.runtime.sendMessage({
        action: Actions.StartBatch,
        projectName,
        scenes,
        tabId: tab.id,
        preCompletedSceneNumbers: getPreCompleted(batchScenes, pendingScenes),
        mode: batchType,
      });
      setStatusMsg('');
    } catch (err: unknown) {
      setStatusMsg('Error: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const stopBatch = () =>
    browser.runtime.sendMessage({ action: Actions.StopBatch }).catch(() => {});

  if (isBatchActive) {
    return (
      <div className="main">
        <div className="project-header">
          <span className="project-title">{batchStatus!.projectName}</span>
          <span className="project-count">
            {batchStatus!.mode === BatchModes.Image ? '🖼 Imágenes · ' : '🎬 Videos · '}
            Escena {String(batchStatus!.currentIndex + 1).padStart(4, '0')} /{' '}
            {batchStatus!.totalScenes} · {doneCount} listas
          </span>
        </div>

        <div className="progress-bar">
          <div className="progress-bar__track">
            <div
              className="progress-bar__fill"
              style={{ width: `${(doneCount / batchStatus!.totalScenes) * 100}%` }}
            />
          </div>
          <span>
            {doneCount}/{batchStatus!.totalScenes}
          </span>
        </div>

        <StatusSceneGrid
          sceneNumbers={batchStatus!.sceneNumbers}
          sceneStatuses={batchStatus!.sceneStatuses}
        />

        <button className="abort-btn" onClick={stopBatch}>
          ■ Detener batch
        </button>
        <p className="batch-note">El batch corre en background — puedes cerrar el popup.</p>
      </div>
    );
  }

  return (
    <div className="main">
      <button className="folder-select-btn" onClick={selectFolder} disabled={loading}>
        {projectHandle ? `📁 ${projectName}` : '📂 Seleccionar carpeta de proyecto'}
      </button>

      {projectHandle && (
        <div className="mode-tabs">
          <button
            className={batchType === BatchModes.Image ? 'active' : ''}
            onClick={() => switchBatchType(BatchModes.Image)}
          >
            🖼 Imágenes
          </button>
          <button
            className={batchType === BatchModes.Video ? 'active' : ''}
            onClick={() => switchBatchType(BatchModes.Video)}
          >
            🎬 Videos
          </button>
        </div>
      )}

      {batchScenes.length > 0 && (
        <>
          <p className="scenes-count">
            {pendingScenes.length} pendientes · {completedScenes.size} ya generadas
          </p>
          <div className="scene-grid">
            {batchScenes.map((s) => (
              <div
                key={s.scene_number}
                className={`scene-cell ${completedScenes.has(s.scene_number) ? 'scene-cell--done' : ''}`}
                title={`Escena ${String(s.scene_number).padStart(4, '0')}`}
              >
                {completedScenes.has(s.scene_number) ? '✓' : '·'}
              </div>
            ))}
          </div>
          {pendingScenes.length > 0 ? (
            <button className="generate-btn" onClick={startBatch} disabled={loading}>
              {loading
                ? batchType === BatchModes.Image
                  ? 'Iniciando...'
                  : 'Cargando imágenes...'
                : `Generar ${batchType === BatchModes.Image ? 'imágenes' : 'videos'} (${pendingScenes.length} pendientes)`}
            </button>
          ) : (
            <p className="status status-success">Todas las escenas ya están generadas ✓</p>
          )}
        </>
      )}

      {batchStatus && !batchStatus.active && batchStatus.totalScenes > 0 && (
        <div className="last-batch">
          <p className="last-batch__label">
            {batchStatus.mode === BatchModes.Image ? '🖼' : '🎬'} Último: {batchStatus.projectName} ·{' '}
            {doneCount}/{batchStatus.totalScenes} completados
          </p>
          <StatusSceneGrid
            sceneNumbers={batchStatus.sceneNumbers}
            sceneStatuses={batchStatus.sceneStatuses}
          />
        </div>
      )}

      {statusMsg && <p className="status status-error">{statusMsg}</p>}
    </div>
  );
}
