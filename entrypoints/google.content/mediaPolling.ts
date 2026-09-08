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
import { sleep, nativeHover } from './domUtils';

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
//
// No stable id for either media type under Flow's Angular rewrite.
// - Image: <img data-media-id> — attribute only appears once done.
// - Video: no id ever, and no <video> in the DOM until hovered (unhovered
//   it's just a poster <img class="thumbnail">). The gallery is also a CDK
//   virtual-scroll list that recycles offscreen tiles, so diffing by id is
//   unsafe (caused real duplicate downloads) — only position 0 ("Recientes"
//   sort) is reliably mounted. So: watch position 0's thumbnail src for a
//   change (no hover needed), then hover once, only after a change is
//   detected, to mount the real <video> and read its actual src.

function getReadyImages(): Map<string, string> {
  const images = new Map<string, string>();
  document.querySelectorAll<HTMLImageElement>('img[data-media-id]').forEach((img) => {
    const id = img.getAttribute('data-media-id');
    if (id && img.src) images.set(id, img.src);
  });
  return images;
}

function getReadyImageIds(): Set<string> {
  return new Set(getReadyImages().keys());
}

// A failed generation renders <flow-error-tile> instead of an <img> — no id
// to diff by, but the count is enough: a new one appearing counts as this
// batch "settling" just like a new successful image would.
function getErrorTileCount(): number {
  return document.querySelectorAll('flow-error-tile').length;
}

// A still-generating image is wrapped in <flow-pending-tile> (confirmed
// against real DOM) — its presence is the direct "not done yet" signal, no
// timing guesses needed. Scenes run one at a time, so any pending tile seen
// while waiting belongs to this generation.
function getPendingTileCount(): number {
  return document.querySelectorAll('flow-pending-tile').length;
}

function getTopGalleryTile(): HTMLElement | null {
  return document.querySelector<HTMLElement>('flow-grid-tile-container');
}

// Ready signal — the thumbnail poster src, always present, no hover needed.
function getTopThumbnailSrc(): string | null {
  const tile = getTopGalleryTile();
  if (!tile || !tile.querySelector('flow-video-tile')) return null;
  return tile.querySelector<HTMLImageElement>('img.thumbnail')?.src ?? null;
}

// Download URL — the real <video> src, only exists once hovered. Called
// once, after a thumbnail change is already seen.
async function getTopVideoUrl(): Promise<string | null> {
  const tile = getTopGalleryTile();
  if (!tile) return null;
  await nativeHover(tile);
  return tile.querySelector<HTMLVideoElement>('video')?.src ?? null;
}

export interface MediaSnapshot {
  imageIds: Set<string>;
  errorCount: number;
  topThumbnailSrc: string | null;
}

export async function getMediaSnapshot(mode: BatchMode): Promise<MediaSnapshot> {
  if (mode === BatchModes.Video) {
    return { imageIds: new Set(), errorCount: 0, topThumbnailSrc: getTopThumbnailSrc() };
  }
  return { imageIds: getReadyImageIds(), errorCount: getErrorTileCount(), topThumbnailSrc: null };
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

// Diffs ready ids against the pre-submit snapshot; new error tiles count as
// settled too. Done once no <flow-pending-tile> is left generating — a
// direct signal, not a timing guess, so a slow variant is never cut short
// while a faster one already resolved. MEDIA_STABILIZE_MS only debounces a
// momentary gap between tiles arriving in separate delivery batches.
async function waitForNewImages(before: MediaSnapshot): Promise<MediaPollResult> {
  const newImages = () => [...getReadyImages()].filter(([id]) => !before.imageIds.has(id));
  const toResult = (images: [string, string][]): MediaPollResult =>
    images.length > 0
      ? { status: MediaPollStatuses.Success, urls: images.map(([, url]) => url) }
      : { status: MediaPollStatuses.NoSuccess };

  let zeroPendingSince: number | null = null;

  for (let attempt = 0; attempt < IMAGE_MEDIA_POLL_MAX_ATTEMPTS; attempt++) {
    if (aborted) return { status: MediaPollStatuses.Aborted };

    const images = newImages();
    const errors = Math.max(0, getErrorTileCount() - before.errorCount);
    const settled = images.length + errors;

    zeroPendingSince =
      getPendingTileCount() === 0 ? (zeroPendingSince ?? Date.now()) : null;

    const reachedMax = settled >= MAX_MEDIA_PER_BATCH;
    const confirmedDone =
      zeroPendingSince !== null && Date.now() - zeroPendingSince >= MEDIA_STABILIZE_MS;

    if (settled > 0 && (reachedMax || confirmedDone)) return toResult(images);

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }

  return toResult(newImages());
}

// Watches position 0's thumbnail for a change, then hovers once to pull
// the real downloadable src.
async function waitForTopVideoChange(beforeSrc: string | null): Promise<MediaPollResult> {
  for (let attempt = 0; attempt < VIDEO_MEDIA_POLL_MAX_ATTEMPTS; attempt++) {
    if (aborted) return { status: MediaPollStatuses.Aborted };

    const thumb = getTopThumbnailSrc();
    if (thumb && thumb !== beforeSrc) {
      const url = await getTopVideoUrl();
      if (url) return { status: MediaPollStatuses.Success, urls: [url] };
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }

  return { status: MediaPollStatuses.NoSuccess };
}

export async function waitForNewMedia(
  before: MediaSnapshot,
  mode: BatchMode = BatchModes.Image
): Promise<MediaPollResult> {
  return mode === BatchModes.Video
    ? waitForTopVideoChange(before.topThumbnailSrc)
    : waitForNewImages(before);
}
