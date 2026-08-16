import { BatchModes } from '../../../../../../lib/types';
import type { BatchMode, BatchStatus } from '../../../../../../lib/types';
import { pad4 } from '../../../../../../lib/constants';
import { StatusSceneGrid } from '../StatusSceneGrid';
import type { SceneData } from '../../BatchMode.types';

interface ProjectSetupViewProps {
  projectHandle: FileSystemDirectoryHandle | null;
  projectName: string;
  batchType: BatchMode;
  batchScenes: SceneData[];
  completedScenes: Set<number>;
  pendingScenes: SceneData[];
  loading: boolean;
  statusMsg: string;
  batchStatus: BatchStatus | null;
  doneCount: number;
  onSelectFolder: () => void;
  onSwitchBatchType: (type: BatchMode) => void;
  onStartBatch: () => void;
}

// Rendered when no batch is running — pick a project folder, switch
// image/video mode, review pending scenes, and kick off a batch.
export function ProjectSetupView({
  projectHandle,
  projectName,
  batchType,
  batchScenes,
  completedScenes,
  pendingScenes,
  loading,
  statusMsg,
  batchStatus,
  doneCount,
  onSelectFolder,
  onSwitchBatchType,
  onStartBatch,
}: ProjectSetupViewProps) {
  return (
    <div className="main">
      <button className="folder-select-btn" onClick={onSelectFolder} disabled={loading}>
        {projectHandle ? `📁 ${projectName}` : '📂 Seleccionar carpeta de proyecto'}
      </button>

      {projectHandle && (
        <div className="mode-tabs">
          <button
            className={batchType === BatchModes.Image ? 'active' : ''}
            onClick={() => onSwitchBatchType(BatchModes.Image)}
          >
            🖼 Imágenes
          </button>
          <button
            className={batchType === BatchModes.Video ? 'active' : ''}
            onClick={() => onSwitchBatchType(BatchModes.Video)}
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
                title={`Escena ${pad4(s.scene_number)}`}
              >
                {completedScenes.has(s.scene_number) ? '✓' : '·'}
              </div>
            ))}
          </div>
          {pendingScenes.length > 0 ? (
            <button className="generate-btn" onClick={onStartBatch} disabled={loading}>
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
