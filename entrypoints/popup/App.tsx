import { useState, useRef, useEffect } from 'react';
import { Actions, BatchModes } from '../../lib/types';
import type { BatchStatus, ExtensionMessage, PendingWrite, LogKind } from '../../lib/types';
import { loadProjectHandle } from './utils';
import {
  ProjectDirs,
  sceneMediaSetFolder,
  sceneGeneratedImageName,
  sceneGeneratedVideoName,
  sceneRefImageName,
} from '../../lib/constants';
import BatchMode from './BatchMode/BatchMode';
import './style.css';

type Mode = 'single' | 'project';

async function writeBlobToFile(dir: FileSystemDirectoryHandle, name: string, blob: Blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(blob);
  await writable.close();
}

const FETCH_TIMEOUT_MS = 60000;
const FETCH_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchBlobWithRetry(url: string): Promise<Blob | null> {
  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      const resp = await fetchWithTimeout(url);
      if (resp.ok) return await resp.blob();
    } catch {
      /* network error or timeout, retry below */
    }
    if (attempt < FETCH_RETRIES - 1) await sleep(RETRY_BACKOFF_MS[attempt]);
  }
  return null;
}

async function getVibesTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.includes('vibes.ai') ? tab : null;
}

type SingleStatus = { type: 'idle' | 'loading' | 'success' | 'error'; message?: string };

function SingleMode() {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<SingleStatus>({ type: 'idle' });

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setStatus({ type: 'error', message: 'Escribe un prompt primero.' });
      return;
    }
    setStatus({ type: 'loading', message: 'Enviando a vibes.ai...' });
    try {
      const tab = await getVibesTab();
      if (!tab?.id) {
        setStatus({
          type: 'error',
          message: 'Abre vibes.ai primero y usa la extensión desde esa pestaña.',
        });
        return;
      }
      const resp = await browser.tabs.sendMessage(tab.id, {
        action: Actions.FillPrompt,
        prompt: prompt.trim(),
        mediaType: BatchModes.Image,
        imageBase64: null,
        imageName: null,
      });
      if (!resp?.success) {
        setStatus({ type: 'error', message: resp?.error ?? 'Error desconocido.' });
        return;
      }
      setStatus({ type: 'success', message: resp.message });
    } catch (err) {
      setStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="main">
      <textarea
        className="prompt-textarea"
        placeholder="Describe la imagen que quieres generar..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={5}
      />
      <button
        className="generate-btn"
        onClick={handleGenerate}
        disabled={status.type === 'loading'}
      >
        {status.type === 'loading' ? 'Enviando...' : 'Generar imagen'}
      </button>
      {status.message && <p className={`status status-${status.type}`}>{status.message}</p>}
    </div>
  );
}

interface LogStatus {
  sceneNumber?: number;
  step: string;
  kind: LogKind;
  attempt?: { current: number; max: number };
  cooldownMs?: number;
  receivedAt: number;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
}

// A single "current status" card instead of a scrolling log — a fresh
// message (new attempt, new step) just replaces the old one, so there's
// nothing stale left on screen to confuse with the current state. The
// cooldown counts down live client-side from the moment the message
// arrived, ticking every 500ms.
function StatusPanel({ status }: { status: LogStatus | null }) {
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
        {status.sceneNumber !== undefined && (
          <span className="log-panel__scene">Escena {status.sceneNumber}</span>
        )}
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

export default function App() {
  const [mode, setMode] = useState<Mode>('single');
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [status, setStatus] = useState<LogStatus | null>(null);
  const grantedHandleRef = useRef<FileSystemDirectoryHandle | null>(null);

  async function processPendingWrite(pw: PendingWrite) {
    const handle = grantedHandleRef.current;
    if (!handle) return;
    try {
      const rootDirName = pw.mode === BatchModes.Image ? ProjectDirs.Images : ProjectDirs.Videos;
      const rootDir = await handle.getDirectoryHandle(rootDirName, { create: true });
      const sceneDir = await rootDir.getDirectoryHandle(sceneMediaSetFolder(pw.sceneNumber), {
        create: true,
      });
      const nameFor =
        pw.mode === BatchModes.Image ? sceneGeneratedImageName : sceneGeneratedVideoName;

      const blobs = await Promise.all(
        pw.urls.map(async (url, i) => {
          const blob = await fetchBlobWithRetry(url);
          if (!blob) return null;
          await writeBlobToFile(sceneDir, nameFor(i), blob);
          return blob;
        })
      );

      // Only image scenes need a "ref" copy — it's the input the video step
      // later reads as the start frame. Videos are a terminal output.
      if (pw.mode === BatchModes.Image) {
        const validBlobs = blobs.filter((b): b is Blob => b !== null);
        if (validBlobs.length > 0) {
          const refBlob = validBlobs[Math.floor(Math.random() * validBlobs.length)];
          await writeBlobToFile(rootDir, sceneRefImageName(pw.sceneNumber), refBlob);
        }
      }

      browser.runtime
        .sendMessage({ action: Actions.WriteDone, sceneNumber: pw.sceneNumber })
        .catch(() => {});
    } catch {
      /* write failed, batch stays on pendingWrite */
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const handle = await loadProjectHandle();
        if (handle) {
          const perm = await (
            handle as FileSystemDirectoryHandle & {
              requestPermission(opts: { mode: string }): Promise<string>;
            }
          ).requestPermission({ mode: 'readwrite' });
          if (perm === 'granted') grantedHandleRef.current = handle;
        }
      } catch {
        /* no stored handle or permission denied */
      }

      try {
        const s = (await browser.runtime.sendMessage({
          action: Actions.GetBatchStatus,
        })) as BatchStatus | null;
        if (s) {
          setBatchStatus(s);
          if (s.active) setMode('project');
          if (s.pendingWrite) processPendingWrite(s.pendingWrite);
        }
      } catch {
        /* background not available */
      }
    })();

    const listener = (msg: ExtensionMessage) => {
      if (msg.action === Actions.BatchStatus) {
        setBatchStatus(msg.status);
        if (msg.status?.pendingWrite) processPendingWrite(msg.status.pendingWrite);
        return;
      }
      if (msg.action === Actions.Log) {
        setStatus({
          sceneNumber: msg.sceneNumber,
          step: msg.step,
          kind: msg.kind,
          attempt: msg.attempt,
          cooldownMs: msg.cooldownMs,
          receivedAt: Date.now(),
        });
      }
    };
    browser.runtime.onMessage.addListener(
      listener as Parameters<typeof browser.runtime.onMessage.addListener>[0]
    );
    return () =>
      browser.runtime.onMessage.removeListener(
        listener as Parameters<typeof browser.runtime.onMessage.addListener>[0]
      );
  }, []);

  return (
    <div id="app">
      <h1>Vibes Image/Video Generator</h1>

      <div className="mode-tabs">
        <button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>
          Escena única
        </button>
        <button className={mode === 'project' ? 'active' : ''} onClick={() => setMode('project')}>
          Proyecto
        </button>
      </div>

      {mode === 'single' && <SingleMode />}
      {mode === 'project' && (
        <BatchMode batchStatus={batchStatus} grantedHandleRef={grantedHandleRef} />
      )}

      <StatusPanel status={status} />

      <p className="footer">v{browser.runtime.getManifest().version}</p>
    </div>
  );
}
