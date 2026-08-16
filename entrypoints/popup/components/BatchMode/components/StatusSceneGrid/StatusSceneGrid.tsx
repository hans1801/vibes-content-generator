import { SceneStatuses } from '../../../../../../lib/types';
import type { SceneStatus } from '../../../../../../lib/types';
import { pad4 } from '../../../../../../lib/constants';

const SCENE_ICONS: Record<string, string> = {
  [SceneStatuses.Processing]: '⏳',
  [SceneStatuses.Done]: '✓',
  [SceneStatuses.Error]: '✗',
};

interface StatusSceneGridProps {
  sceneNumbers: number[];
  sceneStatuses: Record<number, SceneStatus>;
}

export function StatusSceneGrid({ sceneNumbers, sceneStatuses }: StatusSceneGridProps) {
  return (
    <div className="scene-grid">
      {sceneNumbers.map((n) => (
        <div
          key={n}
          className={`scene-cell scene-cell--${sceneStatuses[n] ?? 'pending'}`}
          title={`Escena ${pad4(n)}`}
        >
          {SCENE_ICONS[sceneStatuses[n]] ?? '·'}
        </div>
      ))}
    </div>
  );
}
