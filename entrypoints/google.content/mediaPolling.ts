import { Actions, BatchModes } from '../../lib/types';
import type { BatchMode } from '../../lib/types';
import {
  IMAGE_MEDIA_POLL_MAX_ATTEMPTS,
  VIDEO_MEDIA_POLL_MAX_ATTEMPTS,
  MAX_MEDIA_PER_BATCH,
  MEDIA_STABILIZE_MS,
  MEDIA_POLL_INTERVAL_MS,
} from './constants';
import { aborted } from './abortState';
import { sleep } from './domUtils';

// SendPrompt's sendResponse already fired (instantly, before any of this
// ran) — every outcome from here on, success or failure, travels as its own
// independent message instead. `retryAfterMs` is this site's own rate-limit
// cooldown for the mode in question, so background.ts doesn't have to guess.
export async function reportSceneFailed(sceneNumber: number, reason: string, retryAfterMs: number) {
  await browser.runtime.sendMessage({
    action: Actions.SceneFailed,
    sceneNumber,
    reason,
    retryAfterMs,
  });
}

// ── Tile reading ───────────────────────────────────────────────────────────────

// Every result (image or video) is wrapped in an element with
// data-tile-id="fe_id_<uuid>" — Google Flow renders this wrapper twice
// (outer + inner container, same id), so querySelector (first match) is
// enough; no need to dedupe manually.
function getAllTileIds(): Set<string> {
  const ids = new Set<string>();
  document.querySelectorAll<HTMLElement>('[data-tile-id]').forEach((wrapper) => {
    const id = wrapper.getAttribute('data-tile-id');
    if (id) ids.add(id);
  });
  return ids;
}

export function getMediaTileIds(): Set<string> {
  return getAllTileIds();
}

const TileStatuses = {
  Ready: 'ready',
  Failed: 'failed',
  Pending: 'pending',
} as const;

type TileState =
  | { status: typeof TileStatuses.Ready; isVideo: boolean; url: string }
  | { status: typeof TileStatuses.Failed }
  | { status: typeof TileStatuses.Pending };

// A failed generation renders a "warning" icon (Material Symbols ligature,
// language-independent) with a non-empty reason in .sc-101009f9-2. The same
// warning card also shows up empty for an unrelated "removed/reuse" state
// (action icon "undo" instead of "refresh") — only the one with actual
// reason text is a real failure. Everything else that isn't a real, loaded
// media element is still mid-generation.
function getTileState(id: string): TileState {
  const wrapper = document.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(id)}"]`);
  if (!wrapper) return { status: TileStatuses.Pending };

  const hasWarningIcon = Array.from(wrapper.querySelectorAll('i')).some(
    (i) => i.textContent?.trim() === 'warning'
  );
  const errorReason = wrapper.querySelector('.sc-101009f9-2')?.textContent?.trim();
  if (hasWarningIcon && errorReason) return { status: TileStatuses.Failed };

  const media = wrapper.querySelector<HTMLImageElement | HTMLVideoElement>('img, video');
  if (!media) return { status: TileStatuses.Pending };

  if (media.tagName === 'VIDEO') {
    const video = media as HTMLVideoElement;
    // Unlike vibes.ai, Google Flow's <video> doesn't preload metadata on its
    // own — readyState can stay 0 indefinitely even once the video is done
    // server-side, so it's not a usable readiness signal here. A real src
    // is the only thing to go by.
    const src = video.currentSrc || video.src;
    return src
      ? { status: TileStatuses.Ready, isVideo: true, url: src }
      : { status: TileStatuses.Pending };
  }

  const img = media as HTMLImageElement;
  if (!img.complete || img.naturalWidth === 0 || !img.src) return { status: TileStatuses.Pending };
  return { status: TileStatuses.Ready, isVideo: false, url: img.src };
}

// Converts a blob: URL to a data URL so the extension popup can fetch it
// cross-origin (blob URLs are bound to the originating context).
export async function blobUrlToDataUrl(blobUrl: string): Promise<string> {
  const res = await fetch(blobUrl);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Batch waiting ──────────────────────────────────────────────────────────────

export const MediaPollStatuses = {
  Success: 'success',
  NoSuccess: 'no-success',
  Aborted: 'aborted',
} as const;

export type MediaPollResult =
  | { status: typeof MediaPollStatuses.Success; urls: string[] }
  | { status: typeof MediaPollStatuses.NoSuccess }
  | { status: typeof MediaPollStatuses.Aborted };

// Diffs the current tile ids against beforeIds to find this generation's
// results, and waits for every one of them to settle (ready or failed —
// none still pending). New ids can keep appearing over time (Google Flow
// sometimes delivers variants in separate batches), so once nothing's
// pending, the id count must also hold steady for MEDIA_STABILIZE_MS before
// calling it done — otherwise a variant whose wrapper hasn't even mounted
// yet gets abandoned.
export async function waitForNewMedia(
  beforeIds: Set<string>,
  mode: BatchMode = BatchModes.Image
): Promise<MediaPollResult> {
  const isVideo = mode === BatchModes.Video;
  const maxAttempts = isVideo ? VIDEO_MEDIA_POLL_MAX_ATTEMPTS : IMAGE_MEDIA_POLL_MAX_ATTEMPTS;

  let lastCount = 0;
  let stableSince: number | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (aborted) return { status: MediaPollStatuses.Aborted };

    const newIds = [...getAllTileIds()].filter((id) => !beforeIds.has(id));
    const states = newIds.map((id) => getTileState(id));
    const stillPending = states.some((s) => s.status === TileStatuses.Pending);
    const readyUrls = states.flatMap((s) =>
      s.status === TileStatuses.Ready && s.isVideo === isVideo ? [s.url] : []
    );

    if (newIds.length !== lastCount) {
      // El conteo de ids nuevos cambió (llegó otro wrapper): reinicia la
      // ventana de estabilización.
      lastCount = newIds.length;
      stableSince = Date.now();
    }

    const reachedMax = newIds.length >= MAX_MEDIA_PER_BATCH;
    const isStable = stableSince !== null && Date.now() - stableSince >= MEDIA_STABILIZE_MS;

    if (!stillPending && (reachedMax || isStable)) {
      return readyUrls.length > 0
        ? { status: MediaPollStatuses.Success, urls: readyUrls }
        : { status: MediaPollStatuses.NoSuccess };
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }

  // Timed out — whatever's ready counts as a partial success, same as
  // vibes.ai: at least 1 ready slot is enough, the rest are simply skipped.
  const finalUrls = [...getAllTileIds()]
    .filter((id) => !beforeIds.has(id))
    .map((id) => getTileState(id))
    .flatMap((s) => (s.status === TileStatuses.Ready && s.isVideo === isVideo ? [s.url] : []));

  return finalUrls.length > 0
    ? { status: MediaPollStatuses.Success, urls: finalUrls }
    : { status: MediaPollStatuses.NoSuccess };
}
