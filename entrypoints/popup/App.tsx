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

// ── Single-scene mode ─────────────────────────────────────────────────────────

function SingleMode() {
  const [copied, setCopied] = useState(false);

  const promptText = `Convert the provided video script into the following JSON structure.

For each scene, generate:

* scene_number
* image_prompt
* video_prompt
* narration

Requirements:

* image_prompt must contain exactly the content from the "Image Prompt" section converted into a single plain text string.
* video_prompt must contain exactly the content from the "Video Prompt" section converted into a single plain text string.
* narration must contain exactly the content from the "Narration" section.
* Do not rewrite, improve, summarize, embellish, or reinterpret any scene.
* Preserve all scene details, descriptions, actions, lighting, composition, atmosphere, style, and duration information.
* Keep prompts in English only if the source prompts are in English; otherwise preserve the original language.
* Keep narrations in their original language.
* Return only valid JSON.
* Do not use nested objects.
* Do not omit any information from the original scene.
* Create one JSON scene entry for every scene found in the script.

Output format:

{
  "scenes": [
    {
      "scene_number": 1,
      "image_prompt": "...",
      "video_prompt": "...",
      "narration": "..."
    }
  ]
}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(promptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="main how-to-use">
      <div className="steps-container">
        <div className="step-item">
          <div className="step-badge">1</div>
          <p className="step-text">Primero debes tener todas las escenas de tu guion preparadas.</p>
        </div>

        <div className="step-item">
          <div className="step-badge">2</div>
          <div className="step-content">
            <p className="step-text">
              Adapta tu guion al formato estructurado <code>script.json</code>. Si no lo tienes, copia y usa este prompt para generarlo con IA:
            </p>
            <div className="prompt-wrapper">
              <div className="prompt-container">
                <pre className="prompt-preview">{promptText}</pre>
              </div>
              <button 
                className={`icon-copy-btn ${copied ? 'copied' : ''}`} 
                onClick={handleCopy} 
                title="Copiar prompt"
              >
                {copied ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="step-item">
          <div className="step-badge">3</div>
          <div className="step-content">
            <p className="step-text">
              Guarda el archivo en una carpeta vacía. El archivo debe llamarse <strong>estrictamente</strong> <code>script.json</code>. Estructura inicial:
            </p>
            <div className="folder-structure">
              📁 Mi-Proyecto-AI/<br />
              └── 📄 script.json
            </div>
          </div>
        </div>

        <div className="step-item">
          <div className="step-badge">4</div>
          <div className="step-content">
            <p className="step-text">
              Ve a la pestaña <strong>Proyecto</strong>, selecciona esa carpeta, y haz clic en <strong>Generar Imágenes</strong>. El bot creará automáticamente la subcarpeta <code>images</code> para guardar los resultados:
            </p>
            <div className="folder-structure">
              📁 Mi-Proyecto-AI/<br />
              ├── 📁 images/<br />
              └── 📄 script.json
            </div>
          </div>
        </div>

        <div className="step-item">
          <div className="step-badge">5</div>
          <div className="step-content">
            <p className="step-text">
              Terminadas las imágenes, haz clic en <strong>Generar Videos</strong>. Estos se guardarán en la subcarpeta <code>videos</code>, quedando la estructura final completa:
            </p>
            <div className="folder-structure">
              📁 Mi-Proyecto-AI/<br />
              ├── 📁 images/<br />
              ├── 📁 videos/<br />
              └── 📄 script.json
            </div>
          </div>
        </div>
      </div>
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
      <h1>Content Generator</h1>

      <div className="mode-tabs">
        <button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>
          ¿Cómo usar?
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
