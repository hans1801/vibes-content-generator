import { BatchModes } from '../../../../../../lib/types';
import type { BatchStatus } from '../../../../../../lib/types';
import { pad4 } from '../../../../../../lib/constants';
import { StatusSceneGrid } from '../StatusSceneGrid';

interface ActiveBatchViewProps {
  batchStatus: BatchStatus;
  doneCount: number;
  onStop: () => void;
}

// Rendered while a batch is running in background — progress + controls,
// no project setup UI (that's ProjectSetupView).
export function ActiveBatchView({ batchStatus, doneCount, onStop }: ActiveBatchViewProps) {
  return (
    <div className="main">
      <div className="project-header">
        <span className="project-title">{batchStatus.projectName}</span>
        <span className="project-count">
          {batchStatus.mode === BatchModes.Image ? '🖼 Imágenes · ' : '🎬 Videos · '}
          Escena {pad4(batchStatus.currentIndex + 1)} / {batchStatus.totalScenes} · {doneCount}{' '}
          listas
        </span>
      </div>

      <div className="progress-bar">
        <div className="progress-bar__track">
          <div
            className="progress-bar__fill"
            style={{ width: `${(doneCount / batchStatus.totalScenes) * 100}%` }}
          />
        </div>
        <span>
          {doneCount}/{batchStatus.totalScenes}
        </span>
      </div>

      <StatusSceneGrid
        sceneNumbers={batchStatus.sceneNumbers}
        sceneStatuses={batchStatus.sceneStatuses}
      />

      <button className="abort-btn" onClick={onStop} style={{ width: '100%', marginTop: '16px' }}>
        ■ Detener batch
      </button>
      <p className="batch-note">El batch corre en background — puedes cerrar el popup.</p>
    </div>
  );
}
