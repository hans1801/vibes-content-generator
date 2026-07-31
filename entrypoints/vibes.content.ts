import { Actions, BatchModes, LogKinds } from '../lib/types';
import type { ExtensionMessage, ContentResponse, LogKind } from '../lib/types';
import {
  ComposerSelectors,
  GallerySelectors,
  GenerateButtonSelectors,
  StartEndFrameSelectors,
} from '../lib/selectors/vibes';

// ── Constants ────────────────────────────────────────────────────────────────

const WAIT_TIMEOUT_MS = 8000;
const UPLOAD_WAIT_TIMEOUT_MS = 120000;
const WAIT_INTERVAL_MS = 200;
const MEDIA_POLL_INTERVAL_MS = 2000;
// A CDN file can still be mid-transcode right after its <img>/<video> appears.
// A stabilization pause ensures the final file is downloaded, not a partial.
const MEDIA_STABILIZE_MS = 20000;
// ~5 minutes total; video renders are significantly slower than images.
const MEDIA_POLL_MAX_ATTEMPTS = 150;
const MAX_UPLOAD_ATTEMPTS = 5;
const UPLOAD_RETRY_DELAY_MS = 12000;
const MAX_GENERATION_ATTEMPTS = 5;
// Video scenes hit vibes.ai with two API calls (upload + generate) per scene,
// which triggers rate-limiting faster — give them a longer cooldown.
const GENERATION_RETRY_DELAY_MS = 25000;

const ADD_TO_VIDEO_LABELS = ['Add to video', 'Añadir al vídeo'];
const ADD_START_FRAME_LABELS = ['Add start frame'];
const UPLOAD_LABELS = ['Upload', 'Subir'];
const SELECT_START_FRAME_HEADINGS = ['Select start frame', 'Seleccionar fotograma inicial'];
const UPLOAD_IMAGES_HEADINGS = ['Upload images', 'Cargar imágenes'];
const REMOVE_START_FRAME_LABELS = ['Remove start frame', 'Eliminar el marco de inicio'];

// ── Abort flag ────────────────────────────────────────────────────────────────

// Set to true when the background relays a StopBatch to this tab. Every
// long-running wait checks it so a stop takes effect within a couple of seconds.
let aborted = false;

// ── Utilities ─────────────────────────────────────────────────────────────────

interface LogUpdate {
  sceneNumber?: number;
  step: string;
  kind: LogKind;
  attempt?: { current: number; max: number };
  cooldownMs?: number;
}

function log(update: LogUpdate) {
  browser.runtime.sendMessage({ action: Actions.Log, ...update }).catch(() => {});
}

function waitFor<T>(
  check: () => T | null | undefined,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<T | null> {
  const existing = check();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const result = check();
      if (result || aborted || Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolve(result ?? null);
      }
    }, WAIT_INTERVAL_MS);
  });
}

function waitForEnabledButton(
  selector: string,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<HTMLButtonElement | null> {
  return waitFor(() => {
    const btn = document.querySelector<HTMLButtonElement>(selector);
    return btn && !btn.disabled ? btn : null;
  }, timeoutMs);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sleepAbortable(ms: number) {
  const step = 500;
  let waited = 0;
  while (waited < ms && !aborted) {
    await sleep(Math.min(step, ms - waited));
    waited += step;
  }
}

// Waits until a count has been stable for `quietMs` before trusting it.
// Prevents a still-populating React grid from appearing identical to a
// freshly-landed upload.
async function waitForStableCount(
  getCount: () => number,
  quietMs = 800,
  timeoutMs = UPLOAD_WAIT_TIMEOUT_MS
): Promise<number> {
  const start = Date.now();
  let lastCount = getCount();
  let lastChangeAt = Date.now();
  while (Date.now() - start < timeoutMs && !aborted) {
    await sleep(WAIT_INTERVAL_MS);
    const count = getCount();
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietMs) {
      return lastCount;
    }
  }
  return lastCount;
}

// Dispatches the full pointer + mouse event sequence required to trigger
// Radix UI components (which open on `pointerdown`, not `click`) and
// Framer Motion press handlers (which validate coordinates against element
// bounds). Coordinates are centered on the real element to pass hit-tests.
// A random 1–2 s pause after each click prevents vibes.ai rate-limiting.
async function simulateClick(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, composed: true, clientX, clientY };
  const pointerOpts = { ...opts, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
  el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', { ...opts, detail: 1 }));
  await sleep(1500 + Math.random() * 1500);
}

function dataURLtoFile(dataurl: string, filename: string): File {
  const arr = dataurl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new File([u8arr], filename, { type: mime });
}

// Accepts an array of candidates to handle en/es locale differences.
function findButtonByText(scope: ParentNode, text: string | string[]): HTMLButtonElement | null {
  const candidates = Array.isArray(text) ? text : [text];
  return (
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
      candidates.includes(btn.textContent?.trim() ?? '')
    ) ?? null
  );
}

// Strips diacritics (é, í, ñ…) so locale comparisons aren't tripped up by
// accents — e.g. "Vídeo" vs the "vid" prefix we match against.
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Locates a dialog by climbing ancestors from its heading element until
// `isDone` confirms we've reached the full dialog container.
function resolveDialogByHeadingSync(
  headingText: string | string[],
  isDone: (node: HTMLElement) => boolean
): HTMLElement | null {
  const candidates = Array.isArray(headingText) ? headingText : [headingText];
  const heading = Array.from(document.querySelectorAll<HTMLElement>('div,span,h1,h2,h3')).find(
    (el) => candidates.includes(el.textContent?.trim() ?? '') && el.children.length === 0
  );
  if (!heading) return null;
  let node: HTMLElement | null = heading.parentElement;
  for (let i = 0; i < 12 && node; i++) {
    if (isDone(node)) return node;
    node = node.parentElement;
  }
  return heading.parentElement;
}

function findDialogByHeading(
  headingText: string | string[],
  isDone: (node: HTMLElement) => boolean = (node) =>
    node.querySelectorAll('img, button').length >= 2,
  timeoutMs = UPLOAD_WAIT_TIMEOUT_MS
): Promise<HTMLElement | null> {
  return waitFor(() => resolveDialogByHeadingSync(headingText, isDone), timeoutMs);
}

const hasAddToVideoButton = (node: HTMLElement) => !!findButtonByText(node, ADD_TO_VIDEO_LABELS);

// ── Mode management ───────────────────────────────────────────────────────────

// The composer's aria-label reliably signals the active mode — it switches
// between "Describe an image…" and "Describe a video…" when the mode changes.
function getCurrentMode(): 'image' | 'video' | null {
  const composer = document.querySelector<HTMLElement>(ComposerSelectors.Input);
  const label = stripAccents(
    composer?.getAttribute('aria-label') ?? composer?.getAttribute('title') ?? ''
  );
  if (label.includes('image')) return BatchModes.Image;
  if (label.includes('video')) return BatchModes.Video;
  return null;
}

// The mode-toggle trigger is distinguished from identically-named menu items
// by the fact that it has aria-haspopup="menu" as an ancestor.
function findModeTriggerButton(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((btn) => {
      if (btn.getAttribute('role') === 'menuitem') return false;
      const label = stripAccents(
        btn.querySelector('span')?.textContent?.trim().toLowerCase() ?? ''
      );
      if (!label.startsWith('vid') && !label.startsWith('ima')) return false;
      return !!btn.closest('[aria-haspopup="menu"]');
    }) ?? null
  );
}

async function openModeMenu(): Promise<HTMLElement | null> {
  const trigger = findModeTriggerButton();
  if (!trigger) return null;
  await simulateClick(trigger);
  return waitFor(() => document.querySelector<HTMLElement>('[role="menu"][data-state="open"]'));
}

async function clickMenuItem(menu: HTMLElement, target: 'image' | 'video'): Promise<boolean> {
  const wantedPrefix = target === BatchModes.Image ? 'ima' : 'vid';
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
  const item = items.find((btn) => {
    const text = stripAccents(
      (
        btn.querySelector('span.flex_1')?.textContent?.trim() ??
        btn.textContent?.trim() ??
        ''
      ).toLowerCase()
    );
    return text.startsWith(wantedPrefix);
  });
  if (!item) return false;
  await simulateClick(item);
  return true;
}

async function ensureMode(target: 'image' | 'video'): Promise<boolean> {
  if (getCurrentMode() === target) return true;
  const menu = await openModeMenu();
  if (!menu) return false;
  if (!(await clickMenuItem(menu, target))) return false;
  const result = await waitFor(() => (getCurrentMode() === target ? true : null));
  return result === true;
}

// Waits for the composer node that corresponds to `target` mode. After a
// mode switch, Lexical takes a moment to wire its own event handlers — this
// guarantees we grab the post-switch node before trying to fill it.
async function getSettledComposer(
  target: 'image' | 'video',
  timeoutMs = 5000
): Promise<HTMLElement | null> {
  return waitFor(() => {
    const composer = document.querySelector<HTMLElement>(ComposerSelectors.Input);
    const label = stripAccents(
      composer?.getAttribute('aria-label') ?? composer?.getAttribute('title') ?? ''
    );
    const wanted = target === BatchModes.Image ? 'image' : 'video';
    return composer && label.includes(wanted) ? composer : null;
  }, timeoutMs);
}

// Uses execCommand to write into Lexical's contenteditable. Retries up to 4
// times to handle the race where Lexical hasn't finished wiring handlers yet.
async function fillComposer(composer: HTMLElement, prompt: string): Promise<boolean> {
  const expected = prompt.trim();
  for (let attempt = 0; attempt < 4; attempt++) {
    composer.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, prompt);
    await sleep(200);
    if ((composer.textContent ?? '').trim() === expected) return true;
  }
  return false;
}

// ── Start-frame attachment (video mode) ───────────────────────────────────────

async function ensureStartEndFramePanel(): Promise<boolean> {
  if (findButtonByText(document, ADD_START_FRAME_LABELS)) return true;
  const toggle = document.querySelector<HTMLButtonElement>(StartEndFrameSelectors.Toggle);
  if (!toggle) return false;
  await simulateClick(toggle);
  const found = await waitFor(() => findButtonByText(document, ADD_START_FRAME_LABELS));
  return !!found;
}

function closeAnyOpenDialog() {
  const opts = { bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', ...opts }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', ...opts }));
}

async function removeStartFrame(): Promise<void> {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((el) =>
    REMOVE_START_FRAME_LABELS.includes(el.getAttribute('aria-label') ?? '')
  );
  if (!btn) return;
  await simulateClick(btn);
}

function countUploadFailedToasts(): number {
  return Array.from(document.querySelectorAll<HTMLElement>('span')).filter(
    (el) => el.textContent?.trim() === 'Upload failed'
  ).length;
}

type UploadAttemptResult =
  | { status: 'success'; pickerDialogAfter: HTMLElement; finalCount: number }
  | { status: 'failed' }
  | { status: 'aborted' };

async function attemptUpload(
  pickerDialog: HTMLElement,
  imageBase64: string,
  imageName: string,
  baselineTotalImages: number
): Promise<UploadAttemptResult> {
  const uploadFailBaseline = countUploadFailedToasts();

  const uploadNavBtn = findButtonByText(pickerDialog, UPLOAD_LABELS);
  if (!uploadNavBtn) return { status: 'failed' };
  await simulateClick(uploadNavBtn);

  const uploadDialog = await findDialogByHeading(UPLOAD_IMAGES_HEADINGS);
  if (!uploadDialog) return { status: 'failed' };

  const fileInput =
    uploadDialog.querySelector<HTMLInputElement>('input[type="file"]') ??
    document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) return { status: 'failed' };

  const file = dataURLtoFile(imageBase64, imageName);
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  // Force a pause before confirming — clicking immediately after attaching
  // the file was the cause of vibes.ai rate-limiting.
  await sleep(2000 + Math.random() * 1500);

  const confirmBtn = await waitFor(() => {
    const btn = findButtonByText(uploadDialog, UPLOAD_LABELS);
    return btn && !btn.disabled ? btn : null;
  });
  if (!confirmBtn) return { status: 'failed' };
  await simulateClick(confirmBtn);

  const pickerDialogAfter = await findDialogByHeading(
    SELECT_START_FRAME_HEADINGS,
    hasAddToVideoButton
  );
  if (!pickerDialogAfter) return { status: 'failed' };

  // Re-resolve the dialog on every iteration to avoid holding a stale ref
  // (vibes.ai can remount it after the upload lands).
  const getLiveDialog = () =>
    resolveDialogByHeadingSync(SELECT_START_FRAME_HEADINGS, hasAddToVideoButton);
  const getLiveCount = () => getLiveDialog()?.querySelectorAll('img[data-nimg="fill"]').length ?? 0;

  const deadline = Date.now() + UPLOAD_WAIT_TIMEOUT_MS;
  let finalCount = baselineTotalImages;
  while (Date.now() < deadline) {
    if (aborted) return { status: 'aborted' };
    if (countUploadFailedToasts() > uploadFailBaseline) return { status: 'failed' };

    finalCount = await waitForStableCount(getLiveCount, 800, Math.min(3000, deadline - Date.now()));
    if (finalCount > baselineTotalImages) {
      const liveDialog = getLiveDialog() ?? pickerDialogAfter;
      return { status: 'success', pickerDialogAfter: liveDialog, finalCount };
    }
    if (countUploadFailedToasts() > uploadFailBaseline) return { status: 'failed' };
    await sleep(500);
  }
  return { status: 'failed' };
}

async function selectFirstTile(pickerDialog: HTMLElement): Promise<boolean> {
  const findFirstTile = (): HTMLElement | null => {
    const img = pickerDialog.querySelector<HTMLImageElement>('img[data-nimg="fill"]');
    if (!img) return null;
    return img.closest<HTMLElement>('div') ?? img.parentElement;
  };
  const isAddToVideoEnabled = () => {
    const btn = findButtonByText(pickerDialog, ADD_TO_VIDEO_LABELS);
    return !!btn && !btn.disabled;
  };

  const first = await waitFor(findFirstTile, UPLOAD_WAIT_TIMEOUT_MS);
  if (!first) return false;

  await simulateClick(first);
  const result = await waitFor(() => (isAddToVideoEnabled() ? true : null), 2500);
  return result === true;
}

async function attachStartFrame(
  imageBase64: string,
  imageName: string,
  sceneNumber: number | undefined
): Promise<boolean> {
  log({ sceneNumber, step: 'Adjuntando start frame', kind: LogKinds.Info });

  if (!(await ensureStartEndFramePanel())) {
    log({ sceneNumber, step: 'No se pudo adjuntar el start frame', kind: LogKinds.Error });
    return false;
  }

  const addStartBtn = findButtonByText(document, ADD_START_FRAME_LABELS);
  if (!addStartBtn) {
    log({ sceneNumber, step: 'No se pudo adjuntar el start frame', kind: LogKinds.Error });
    return false;
  }
  await simulateClick(addStartBtn);

  const pickerDialog = await findDialogByHeading(SELECT_START_FRAME_HEADINGS, hasAddToVideoButton);
  if (!pickerDialog) {
    log({ sceneNumber, step: 'No se pudo adjuntar el start frame', kind: LogKinds.Error });
    return false;
  }

  const baselineTotalImages = await waitForStableCount(
    () => pickerDialog.querySelectorAll('img[data-nimg="fill"]').length
  );

  let uploadResult: UploadAttemptResult = { status: 'failed' };
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    if (aborted) {
      uploadResult = { status: 'aborted' };
      break;
    }
    log({
      sceneNumber,
      step: 'Subiendo start frame',
      kind: LogKinds.Info,
      attempt: { current: attempt, max: MAX_UPLOAD_ATTEMPTS },
    });
    uploadResult = await attemptUpload(pickerDialog, imageBase64, imageName, baselineTotalImages);
    if (uploadResult.status !== 'failed') break;
    if (attempt >= MAX_UPLOAD_ATTEMPTS) break;
    log({
      sceneNumber,
      step: 'Subida falló, reintentando',
      kind: LogKinds.Retry,
      attempt: { current: attempt, max: MAX_UPLOAD_ATTEMPTS },
      cooldownMs: UPLOAD_RETRY_DELAY_MS,
    });
    await sleepAbortable(UPLOAD_RETRY_DELAY_MS);

    // If the grid already grew past baseline, the previous upload did land.
    // Treat it as success to avoid creating a duplicate upload.
    const liveDialog =
      resolveDialogByHeadingSync(SELECT_START_FRAME_HEADINGS, hasAddToVideoButton) ?? pickerDialog;
    const liveCount = liveDialog.querySelectorAll('img[data-nimg="fill"]').length;
    if (liveCount > baselineTotalImages) {
      uploadResult = { status: 'success', pickerDialogAfter: liveDialog, finalCount: liveCount };
      break;
    }
  }

  if (uploadResult.status !== 'success') {
    log({ sceneNumber, step: 'No se pudo adjuntar el start frame', kind: LogKinds.Error });
    closeAnyOpenDialog();
    await sleep(300);
    return false;
  }

  log({ sceneNumber, step: 'Start frame subido', kind: LogKinds.Success });

  const { pickerDialogAfter } = uploadResult;
  const selected = await selectFirstTile(pickerDialogAfter);
  if (!selected) return false;

  const addToVideoBtn = findButtonByText(pickerDialogAfter, ADD_TO_VIDEO_LABELS);
  if (!addToVideoBtn || addToVideoBtn.disabled) return false;
  await simulateClick(addToVideoBtn);

  return true;
}

// ── Gallery polling ───────────────────────────────────────────────────────────

interface ReadyThumbnail {
  mediaId: string;
  batchId: string;
  index: number;
  url: string;
}

function getReadyThumbnails(): ReadyThumbnail[] {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(GallerySelectors.Thumbnail));
  const result: ReadyThumbnail[] = [];
  for (const card of cards) {
    const mediaId = card.getAttribute('data-analytics-media-id');
    if (!mediaId) continue;

    const img = card.querySelector<HTMLImageElement>('img[data-nimg="fill"]');
    const video = card.querySelector<HTMLVideoElement>('video[src]');

    let url: string | null = null;
    if (img && img.complete && img.naturalWidth > 0) url = img.src;
    else if (video && video.src) url = video.src;
    if (!url) continue;

    const [batchId, indexPart] = mediaId.split('-content-');
    if (!batchId || indexPart === undefined) continue;
    result.push({ mediaId, batchId, index: Number(indexPart), url });
  }
  return result;
}

// A generation batch is considered complete when any single batchId has
// accumulated 4 ready thumbnails.
function findNewBatch(beforeIds: Set<string>): ReadyThumbnail[] | null {
  const fresh = getReadyThumbnails().filter((t) => !beforeIds.has(t.mediaId));
  const byBatch = new Map<string, ReadyThumbnail[]>();
  for (const t of fresh) {
    const arr = byBatch.get(t.batchId) ?? [];
    arr.push(t);
    byBatch.set(t.batchId, arr);
  }
  for (const arr of byBatch.values()) {
    if (arr.length >= 4) return arr.sort((a, b) => a.index - b.index).slice(0, 4);
  }
  return null;
}

// Re-reads the src right before downloading to pick up the final CDN URL
// if it was swapped during the stabilization window.
function getUrlByMediaId(mediaId: string): string | null {
  const card = document.querySelector<HTMLElement>(
    `[data-analytics-media-id="${CSS.escape(mediaId)}"]`
  );
  if (!card) return null;
  const img = card.querySelector<HTMLImageElement>('img[data-nimg="fill"]');
  const video = card.querySelector<HTMLVideoElement>('video[src]');
  if (img && img.complete && img.naturalWidth > 0) return img.src;
  if (video && video.src) return video.src;
  return null;
}

// "Couldn't generate" cards persist in the DOM after retries succeed, so
// we compare against a baseline taken before each attempt.
function countGenerationErrors(): number {
  return Array.from(document.querySelectorAll<HTMLElement>('span')).filter(
    (el) => el.textContent?.trim() === "Couldn't generate"
  ).length;
}

type MediaPollResult =
  | { status: 'success'; urls: string[] }
  | { status: 'error' }
  | { status: 'timeout' }
  | { status: 'aborted' };

async function waitForMediaBatch(
  beforeIds: Set<string>,
  errorBaseline: number
): Promise<MediaPollResult> {
  for (let attempts = 0; attempts < MEDIA_POLL_MAX_ATTEMPTS; attempts++) {
    if (aborted) return { status: 'aborted' };
    if (countGenerationErrors() > errorBaseline) return { status: 'error' };

    const batchMedia = findNewBatch(beforeIds);
    if (batchMedia) {
      await sleepAbortable(MEDIA_STABILIZE_MS);
      if (aborted) return { status: 'aborted' };
      const urls = batchMedia.map((t) => getUrlByMediaId(t.mediaId) ?? t.url);
      return { status: 'success', urls };
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }
  return { status: 'timeout' };
}

async function generateWithRetries(
  beforeIds: Set<string>,
  sceneNumber: number,
  clickGenerate: () => Promise<boolean>
) {
  let errorBaseline = countGenerationErrors();

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    if (aborted) return;

    log({
      sceneNumber,
      step: 'Esperando generación',
      kind: LogKinds.Info,
      attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
      cooldownMs: MEDIA_POLL_MAX_ATTEMPTS * MEDIA_POLL_INTERVAL_MS,
    });
    const result = await waitForMediaBatch(beforeIds, errorBaseline);

    if (result.status === 'aborted') return;

    if (result.status === 'success') {
      log({ sceneNumber, step: 'Media lista, descargando', kind: LogKinds.Success });
      await browser.runtime.sendMessage({
        action: Actions.DownloadMediaDirect,
        urls: result.urls,
        sceneNumber,
      });
      return;
    }

    if (result.status === 'timeout') {
      const timeoutMinutes = (MEDIA_POLL_MAX_ATTEMPTS * MEDIA_POLL_INTERVAL_MS) / 60000;
      log({
        sceneNumber,
        step: `Tiempo agotado esperando media (${timeoutMinutes} min)`,
        kind: LogKinds.Error,
      });
      await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
      return;
    }

    // status === 'error'
    if (attempt >= MAX_GENERATION_ATTEMPTS) {
      log({
        sceneNumber,
        step: 'Generación falló tras todos los intentos, saltando escena',
        kind: LogKinds.Error,
        attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
      });
      await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
      return;
    }

    log({
      sceneNumber,
      step: 'Generación falló, reintentando',
      kind: LogKinds.Retry,
      attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
      cooldownMs: GENERATION_RETRY_DELAY_MS,
    });
    await sleepAbortable(GENERATION_RETRY_DELAY_MS);
    if (aborted) return;

    // Update baseline so the next attempt only fires on a genuinely new error.
    errorBaseline = countGenerationErrors();

    const clicked = await clickGenerate();
    if (!clicked) {
      log({ sceneNumber, step: 'No se pudo reintentar, saltando escena', kind: LogKinds.Error });
      await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
      return;
    }
  }
}

// ── Mode handlers ─────────────────────────────────────────────────────────────

async function handleImageMode(
  prompt: string,
  sceneNumber: number | undefined,
  sendResponse: (r: ContentResponse) => void
) {
  log({ sceneNumber, step: 'Generando imagen', kind: LogKinds.Info });

  const switched = await ensureMode(BatchModes.Image);
  if (!switched) {
    sendResponse({ success: false, error: 'No se pudo activar el modo imagen.' });
    return;
  }

  const composer = await getSettledComposer(BatchModes.Image);
  if (!composer) {
    sendResponse({ success: false, error: 'Compositor no encontrado.' });
    return;
  }

  const filled = await fillComposer(composer, prompt);
  if (!filled) {
    sendResponse({ success: false, error: 'No se pudo escribir el prompt.' });
    return;
  }

  const beforeIds = new Set(getReadyThumbnails().map((t) => t.mediaId));

  const clickGenerate = async (): Promise<boolean> => {
    if ((composer.textContent ?? '').trim() !== prompt.trim()) {
      if (!(await fillComposer(composer, prompt))) return false;
    }
    await sleep(1300);
    const btn = await waitForEnabledButton(GenerateButtonSelectors.Image);
    if (!btn) return false;
    await simulateClick(btn);
    return true;
  };

  if (!(await clickGenerate())) {
    sendResponse({ success: false, error: 'Botón Generate no disponible.' });
    return;
  }

  sendResponse({ success: true, message: 'Enviado. Esperando imágenes...' });
  if (sceneNumber !== undefined) generateWithRetries(beforeIds, sceneNumber, clickGenerate);
}

async function handleVideoMode(
  prompt: string,
  imageBase64: string | null,
  imageName: string | null,
  sceneNumber: number | undefined,
  sendResponse: (r: ContentResponse) => void
) {
  log({ sceneNumber, step: 'Generando video', kind: LogKinds.Info });

  const switched = await ensureMode(BatchModes.Video);
  if (!switched) {
    sendResponse({ success: false, error: 'No se pudo activar el modo video.' });
    return;
  }

  if (imageBase64 && imageName) {
    const attached = await attachStartFrame(imageBase64, imageName, sceneNumber);
    if (!attached) {
      sendResponse({ success: false, error: 'No se pudo adjuntar el start frame.' });
      return;
    }
  }

  const composer = await getSettledComposer(BatchModes.Video);
  if (!composer) {
    sendResponse({ success: false, error: 'Compositor no encontrado.' });
    return;
  }

  const filled = await fillComposer(composer, prompt);
  if (!filled) {
    sendResponse({ success: false, error: 'No se pudo escribir el prompt.' });
    return;
  }

  const beforeIds = new Set(getReadyThumbnails().map((t) => t.mediaId));

  const clickGenerate = async (): Promise<boolean> => {
    if ((composer.textContent ?? '').trim().length === 0) {
      if (!(await fillComposer(composer, prompt))) return false;
    }
    await sleep(1300);
    const btn = await waitForEnabledButton(GenerateButtonSelectors.Video);
    if (!btn) return false;
    await simulateClick(btn);
    return true;
  };

  if (!(await clickGenerate())) {
    sendResponse({ success: false, error: 'Botón Generate no disponible.' });
    return;
  }

  sendResponse({ success: true, message: 'Enviado. Esperando videos...' });

  if (sceneNumber !== undefined) {
    await generateWithRetries(beforeIds, sceneNumber, clickGenerate);
  }

  // Clear the start frame only after the scene is fully done (success,
  // timeout, or exhausted retries). Retries need it still attached.
  await removeStartFrame();
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default defineContentScript({
  matches: ['*://*.vibes.ai/*', '*://vibes.ai/*'],
  main() {
    browser.runtime.onMessage.addListener(
      (message: ExtensionMessage, _sender, sendResponse: (r: ContentResponse) => void) => {
        if (message.action === Actions.StopBatch) {
          aborted = true;
          return false;
        }

        if (message.action !== Actions.FillPrompt) return false;

        aborted = false;
        const { prompt, mediaType, imageBase64, imageName, sceneNumber } = message;

        if (mediaType === BatchModes.Image) {
          handleImageMode(prompt, sceneNumber, sendResponse);
        } else {
          handleVideoMode(prompt, imageBase64, imageName, sceneNumber, sendResponse);
        }

        return true;
      }
    );
  },
});
