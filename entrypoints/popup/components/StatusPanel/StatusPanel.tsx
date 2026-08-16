import { useState, useEffect, useRef } from 'react';
import type { LogStatus } from '../../App.types';

function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
}

function LogEntry({
  status,
  now,
  showScene,
}: {
  status: LogStatus;
  now: number;
  showScene: boolean;
}) {
  const remainingMs = status.cooldownMs
    ? Math.max(0, status.cooldownMs - (now - status.receivedAt))
    : null;
  const progress = status.cooldownMs && remainingMs !== null ? remainingMs / status.cooldownMs : 0;

  return (
    <div
      className={`log-panel log-panel--${status.kind}`}
      style={{ marginLeft: status.level * 14 }}
    >
      <div className="log-panel__row">
        {showScene && <span className="log-panel__scene">Escena {status.sceneNumber}</span>}
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

// Collapsing step tree for the current scene, indented by depth.
export function StatusPanel({ history }: { history: LogStatus[] }) {
  const [now, setNow] = useState(Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const stack = history.filter((s): s is LogStatus => Boolean(s));

  useEffect(() => {
    if (!stack.some((s) => s.cooldownMs)) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on source, not derived `stack`
  }, [history]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [history]);

  if (stack.length === 0) return null;

  return (
    <div className="log-history" ref={listRef}>
      {stack.map((status, i) => (
        <LogEntry key={i} status={status} now={now} showScene={i === 0} />
      ))}
    </div>
  );
}
