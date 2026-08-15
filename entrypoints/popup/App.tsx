import { useState, useRef, useEffect } from 'react';
import { Actions, BatchModes, BatchSites } from '../../lib/types';
import type { BatchStatus, ExtensionMessage, PendingWrite } from '../../lib/types';
import { restoreProjectHandle } from './utils';
import {
  ProjectDirs,
  sceneMediaSetFolder,
  sceneGeneratedImageName,
  sceneGeneratedVideoName,
  sceneRefImageName,
  sceneRefVideoName,
} from '../../lib/constants';
import { BatchMode } from './components/BatchMode';
import { HowToUseMode } from './components/HowToUseMode';
import { StatusPanel } from './components/StatusPanel';
import { fetchBlobWithRetry, writeBlobToFile, blurWatermarkCorner } from './mediaDownload';
import { AppModes } from './App.types';
import type { AppMode, LogStatus } from './App.types';
import './style.css';

const MODE_TABS: { mode: AppMode; label: string }[] = [
  { mode: AppModes.HowToUse, label: '¿Cómo usar?' },
  { mode: AppModes.Project, label: 'Proyecto' },
];

export default function App() {
  const [mode, setMode] = useState<AppMode>(AppModes.HowToUse);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [logStatus, setLogStatus] = useState<LogStatus | null>(null);
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
          let blob = await fetchBlobWithRetry(url);
          if (!blob) return null;
          // Only vibes.ai stamps a watermark — Flow images don't need this.
          if (pw.mode === BatchModes.Image && pw.site === BatchSites.Vibes) {
            blob = await blurWatermarkCorner(blob);
          }
          await writeBlobToFile(sceneDir, nameFor(i), blob);
          return blob;
        })
      );

      // Pick the first successfully downloaded blob as the scene reference.
      // Using index 0 (instead of random) gives deterministic, reproducible results.
      const validBlobs = blobs.filter((b): b is Blob => b !== null);
      if (validBlobs.length > 0) {
        const refName =
          pw.mode === BatchModes.Image
            ? sceneRefImageName(pw.sceneNumber)
            : sceneRefVideoName(pw.sceneNumber);
        await writeBlobToFile(rootDir, refName, validBlobs[0]);
      }

      browser.runtime
        .sendMessage({ action: Actions.WriteDone, sceneNumber: pw.sceneNumber })
        .catch(() => {});
    } catch {
      /* Write failed — batch stays on pendingWrite and will retry on next popup open. */
    }
  }

  // One-time init on mount: reconnect the last project folder (if still
  // granted) and fetch whatever batch was already running in background.
  useEffect(() => {
    (async () => {
      const handle = await restoreProjectHandle();
      if (handle) grantedHandleRef.current = handle;

      try {
        const s = (await browser.runtime.sendMessage({
          action: Actions.GetBatchStatus,
        })) as BatchStatus | null;
        if (s) {
          setBatchStatus(s);
          if (s.active) setMode(AppModes.Project);
          if (s.pendingWrite) processPendingWrite(s.pendingWrite);
        }
      } catch {
        /* Background service worker not yet available. */
      }
    })();
  }, []);

  // Live updates while the popup stays open: batch progress and step logs
  // pushed from background/content scripts.
  useEffect(() => {
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
      <h1>Content AI Generator</h1>

      <div className="mode-tabs">
        {MODE_TABS.map((tab) => (
          <button
            key={tab.mode}
            className={mode === tab.mode ? 'active' : ''}
            onClick={() => setMode(tab.mode)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === AppModes.HowToUse && <HowToUseMode />}
      {mode === AppModes.Project && (
        <BatchMode batchStatus={batchStatus} grantedHandleRef={grantedHandleRef} />
      )}

      <StatusPanel status={logStatus} />

      <p className="footer">v{browser.runtime.getManifest().version}</p>
    </div>
  );
}
