import { useState, useEffect } from 'react';
import type { LogStatus } from '../../App.types';

function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
}

// A single "current status" card that replaces itself on each new message —
// no scrollback, no stale state visible on screen.
export function StatusPanel({ status }: { status: LogStatus | null }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!status?.cooldownMs) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [status]);

  if (!status) return null;

  const remainingMs = status.cooldownMs
    ? Math.max(0, status.cooldownMs - (now - status.receivedAt))
    : null;
  const progress = status.cooldownMs && remainingMs !== null ? remainingMs / status.cooldownMs : 0;

  return (
    <div className={`log-panel log-panel--${status.kind}`}>
      <div className="log-panel__row">
        <span className="log-panel__scene">Escena {status.sceneNumber}</span>
        {status.attempt && (
          <span className="log-panel__attempt">
            Intento {status.attempt.current}/{status.attempt.max}
          </span>
        )}
      </div>
      <p className="log-panel__step">{status.step}</p>
      {remainingMs !== null && remainingMs > 0 && (
        <div className="log-panel__cooldown">
          <div className="log-panel__cooldown-track">
            <div className="log-panel__cooldown-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="log-panel__cooldown-time">{formatCountdown(remainingMs)}</span>
        </div>
      )}
    </div>
  );
}
