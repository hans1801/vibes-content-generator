import { useState } from 'react';
import { Actions, SceneStatuses, BatchModes, BatchSites } from '../../../../lib/types';
import type { BatchMode, BatchSite, BatchStatus, SceneInput } from '../../../../lib/types';
import { storeProjectHandle } from '../../utils';
import { ProjectFiles, SUPPORTED_SITES } from '../../../../lib/constants';
import { ActiveBatchView } from './components/ActiveBatchView';
import { ProjectSetupView } from './components/ProjectSetupView';
import { getPreCompleted } from './scenePrompts';
import {
  readCompletedScenes,
  validateSceneRefImages,
  buildImageScenes,
  buildVideoScenes,
} from './projectFiles';
import type { SceneData } from './BatchMode.types';

// Only vibes.ai stamps a watermark that needs blurring (see mediaDownload.ts)
// — default to Flow when the tab's URL is missing/unrecognized so we never
// blur a Flow-generated image by mistake.
function detectSite(tabUrl: string | undefined): BatchSite {
  return tabUrl?.includes('vibes.ai') ? BatchSites.Vibes : BatchSites.Flow;
}

interface Props {
  batchStatus: BatchStatus | null;
  grantedHandleRef: { current: FileSystemDirectoryHandle | null };
  onBatchStart: () => void;
  onBatchStop: () => void;
}

export default function BatchMode({
  batchStatus,
  grantedHandleRef,
  onBatchStart,
  onBatchStop,
}: Props) {
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

  const selectFolder = async () => {
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await showDirectoryPicker({ mode: 'readwrite' });
    } catch (err: unknown) {
      if ((err as DOMException)?.name !== 'AbortError') {
        setStatusMsg('No se pudo abrir el selector de carpetas.');
      }
      return;
    }

    setProjectHandle(handle);
    setProjectName(handle.name);
    grantedHandleRef.current = handle;
    setStatusMsg('');

    try {
      await storeProjectHandle(handle);
      const scriptFile = await (await handle.getFileHandle(ProjectFiles.Script)).getFile();
      const { scenes } = JSON.parse(await scriptFile.text()) as { scenes: SceneData[] };
      setBatchScenes(scenes);
      setCompletedScenes(await readCompletedScenes(handle, batchType));
    } catch {
      setStatusMsg('No se pudo leer script.json del proyecto.');
    }
  };

  const switchBatchType = async (type: BatchMode) => {
    setBatchType(type);
    if (projectHandle) setCompletedScenes(await readCompletedScenes(projectHandle, type));
  };

  const startBatch = async () => {
    if (!projectHandle || pendingScenes.length === 0) return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatusMsg(
        `Abre ${SUPPORTED_SITES.map((s) => s.name).join(' o ')} en la pestaña activa primero.`
      );
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
          ? buildImageScenes(pendingScenes)
          : await buildVideoScenes(projectHandle, pendingScenes);

      onBatchStart();
      await browser.runtime.sendMessage({
        action: Actions.StartBatch,
        projectName,
        scenes,
        tabId: tab.id,
        preCompletedSceneNumbers: getPreCompleted(batchScenes, pendingScenes),
        mode: batchType,
        site: detectSite(tab.url),
      });
      setStatusMsg('');
    } catch (err: unknown) {
      setStatusMsg('Error: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  // Fire-and-forget: background owns the running batch, popup just notifies
  // and doesn't care if the message fails to land (e.g. popup closing).
  const notifyBackground = (message: object) =>
    browser.runtime.sendMessage(message).catch(() => {});

  const stopBatch = () => {
    onBatchStop();
    notifyBackground({ action: Actions.StopBatch });
  };

  if (isBatchActive) {
    return <ActiveBatchView batchStatus={batchStatus} doneCount={doneCount} onStop={stopBatch} />;
  }

  return (
    <ProjectSetupView
      projectHandle={projectHandle}
      projectName={projectName}
      batchType={batchType}
      batchScenes={batchScenes}
      completedScenes={completedScenes}
      pendingScenes={pendingScenes}
      loading={loading}
      statusMsg={statusMsg}
      batchStatus={batchStatus}
      doneCount={doneCount}
      onSelectFolder={selectFolder}
      onSwitchBatchType={switchBatchType}
      onStartBatch={startBatch}
    />
  );
}
