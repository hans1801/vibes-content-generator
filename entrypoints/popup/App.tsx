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
  sceneRefVideoName,
} from '../../lib/constants';
import BatchMode from './BatchMode/BatchMode';
import './style.css';

type AppMode = 'single' | 'project';

// ── File system helpers ───────────────────────────────────────────────────────

async function writeBlobToFile(dir: FileSystemDirectoryHandle, name: string, blob: Blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(blob);
  await writable.close();
}

// ── Network helpers ───────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 60000;
const FETCH_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBlobWithRetry(url: string): Promise<Blob | null> {
  // data: URLs don't need a network request — decode them directly.
  if (url.startsWith('data:')) {
    try {
      const res = await fetch(url);
      return await res.blob();
    } catch {
      return null;
    }
  }

  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      const resp = await fetchWithTimeout(url);
      if (resp.ok) return await resp.blob();
    } catch {
      /* network error or timeout — retry below */
    }
    if (attempt < FETCH_RETRIES - 1) await sleep(RETRY_BACKOFF_MS[attempt]);
  }
  return null;
}

// ── Watermark removal ─────────────────────────────────────────────────────────

// Vibes.ai stamps a "Meta AI" watermark in the bottom-right corner.
// Blurring that region makes it illegible without altering the image framing.
async function blurWatermarkCorner(blob: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0);

    const regionW = Math.round(bitmap.width * 0.22);
    const regionH = Math.round(bitmap.height * 0.07);
    const x = bitmap.width - regionW;
    const y = bitmap.height - regionH;

    ctx.filter = 'blur(14px)';
    ctx.drawImage(canvas, x, y, regionW, regionH, x, y, regionW, regionH);
    ctx.filter = 'none';

    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  } catch {
    return blob;
  }
}

// ── Platform tab detection ────────────────────────────────────────────────────

async function getActivePlatformTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  if (url.includes('vibes.ai') || url.includes('labs.google')) return tab;
  return null;
}

// ── Single-scene mode ─────────────────────────────────────────────────────────

type SingleStatus = { type: 'idle' | 'loading' | 'success' | 'error'; message?: string };

function SingleMode() {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<SingleStatus>({ type: 'idle' });

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setStatus({ type: 'error', message: 'Escribe un prompt primero.' });
      return;
    }
    setStatus({ type: 'loading', message: 'Enviando...' });
    try {
      const tab = await getActivePlatformTab();
      if (!tab?.id) {
        setStatus({ type: 'error', message: 'Abre vibes.ai o Google Flow primero.' });
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
      <button className="generate-btn" onClick={handleGenerate} disabled={status.type === 'loading'}>
        {status.type === 'loading' ? 'Enviando...' : 'Generar imagen'}
      </button>
      {status.message && <p className={`status status-${status.type}`}>{status.message}</p>}
    </div>
  );
}

// ── Status panel (live log) ───────────────────────────────────────────────────

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

// A single "current status" card that replaces itself on each new message —
// no scrollback, no stale state visible on screen.
function StatusPanel({ status }: { status: LogStatus | null }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!status?.cooldownMs) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [status]);

  if (!status) return null;

  const remainingMs = status.cooldownMs ? Math.max(0, status.cooldownMs - (now - status.receivedAt)) : null;
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

// ── Root component ────────────────────────────────────────────────────────────

export default function App() {
  const [mode, setMode] = useState<AppMode>('single');
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [logStatus, setLogStatus] = useState<LogStatus | null>(null);
  const grantedHandleRef = useRef<FileSystemDirectoryHandle | null>(null);

  async function processPendingWrite(pw: PendingWrite) {
    const handle = grantedHandleRef.current;
    if (!handle) return;
    try {
      const rootDirName = pw.mode === BatchModes.Image ? ProjectDirs.Images : ProjectDirs.Videos;
      const rootDir = await handle.getDirectoryHandle(rootDirName, { create: true });
      const sceneDir = await rootDir.getDirectoryHandle(sceneMediaSetFolder(pw.sceneNumber), { create: true });
      const nameFor = pw.mode === BatchModes.Image ? sceneGeneratedImageName : sceneGeneratedVideoName;

      const blobs = await Promise.all(
        pw.urls.map(async (url, i) => {
          let blob = await fetchBlobWithRetry(url);
          if (!blob) return null;
          // Only apply the watermark blur to Vibes-generated images, not videos.
          if (pw.mode === BatchModes.Image) blob = await blurWatermarkCorner(blob);
          await writeBlobToFile(sceneDir, nameFor(i), blob);
          return blob;
        }),
      );

      // Pick the first successfully downloaded blob as the scene reference.
      // Using index 0 (instead of random) gives deterministic, reproducible results.
      const validBlobs = blobs.filter((b): b is Blob => b !== null);
      if (validBlobs.length > 0) {
        const refName =
          pw.mode === BatchModes.Image ? sceneRefImageName(pw.sceneNumber) : sceneRefVideoName(pw.sceneNumber);
        await writeBlobToFile(rootDir, refName, validBlobs[0]);
      }

      browser.runtime.sendMessage({ action: Actions.WriteDone, sceneNumber: pw.sceneNumber }).catch(() => {});
    } catch {
      /* Write failed — batch stays on pendingWrite and will retry on next popup open. */
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
        /* No stored handle or permission denied. */
      }

      try {
        const s = (await browser.runtime.sendMessage({ action: Actions.GetBatchStatus })) as BatchStatus | null;
        if (s) {
          setBatchStatus(s);
          if (s.active) setMode('project');
          if (s.pendingWrite) processPendingWrite(s.pendingWrite);
        }
      } catch {
        /* Background service worker not yet available. */
      }
    })();

    const listener = (msg: ExtensionMessage) => {
      if (msg.action === Actions.BatchStatus) {
        setBatchStatus(msg.status);
        if (msg.status?.pendingWrite) processPendingWrite(msg.status.pendingWrite);
        return;
      }
      if (msg.action === Actions.Log) {
        setLogStatus({
          sceneNumber: msg.sceneNumber,
          step: msg.step,
          kind: msg.kind,
          attempt: msg.attempt,
          cooldownMs: msg.cooldownMs,
          receivedAt: Date.now(),
        });
      }
    };
    browser.runtime.onMessage.addListener(listener as Parameters<typeof browser.runtime.onMessage.addListener>[0]);
    return () =>
      browser.runtime.onMessage.removeListener(
        listener as Parameters<typeof browser.runtime.onMessage.addListener>[0],
      );
  }, []);

  return (
    <div id="app">
      <h1>OmniFlow AI</h1>

      <div className="mode-tabs">
        <button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>
          Escena única
        </button>
        <button className={mode === 'project' ? 'active' : ''} onClick={() => setMode('project')}>
          Proyecto
        </button>
      </div>

      {mode === 'single' && <SingleMode />}
      {mode === 'project' && <BatchMode batchStatus={batchStatus} grantedHandleRef={grantedHandleRef} />}

      <StatusPanel status={logStatus} />

      <p className="footer">v{browser.runtime.getManifest().version}</p>
    </div>
  );
}
