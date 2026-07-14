import { Actions, BatchModes } from '../lib/types';
import type { ExtensionMessage, ContentResponse } from '../lib/types';
import {
  ComposerSelectors,
  GallerySelectors,
  GenerateButtonSelectors,
  StartEndFrameSelectors,
} from '../lib/constants';

// Bump on every meaningful content-script change and check this is the
// first line in the log panel after reloading — confirms the extension
// actually picked up the latest build instead of a stale cached one.
const CONTENT_SCRIPT_BUILD = 'v26-live-dialog-resolve';

const WAIT_TIMEOUT_MS = 8000;
// A project with a lot of accumulated images can take a while to fully
// re-render after the picker dialog remounts post-upload — 45s wasn't
// always enough for that alone, before the real upload even factors in.
const UPLOAD_WAIT_TIMEOUT_MS = 120000;
const WAIT_INTERVAL_MS = 200;
const MEDIA_POLL_INTERVAL_MS = 2000;
// A <video src>/<img> appearing doesn't mean the CDN file behind it is
// final — it can still be mid-transcode/swap for a bit, and downloading
// during that window produces a corrupt file. Give it a beat to settle.
const MEDIA_STABILIZE_MS = 20000;
const MEDIA_POLL_MAX_ATTEMPTS = 150; // ~5 minutes, video renders slower than image

const DEBUG = true;

// DevTools on the vibes.ai tab is easy to miss/forget to open, so every log
// also gets forwarded to the popup (if it's open) via runtime messaging —
// same fire-and-forget pattern as the batch status broadcasts.
function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function log(...args: unknown[]) {
  if (!DEBUG) return;
  console.debug('[vibes-ext]', ...args);
  const text = args.map(stringifyArg).join(' ');
  browser.runtime.sendMessage({ action: Actions.DebugLog, text }).catch(() => {});
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

// Set true when the popup's "Detener batch" reaches this tab (background
// relays it directly, since `batch.active = false` on its own only stops
// the NEXT scene from being queued — it has no effect on whatever this tab
// is already in the middle of doing). Every long-running wait below checks
// it periodically so a stop actually stops things within a couple seconds,
// not whenever the current multi-minute wait happens to finish.
let aborted = false;

async function sleepAbortable(ms: number) {
  const step = 500;
  let waited = 0;
  while (waited < ms && !aborted) {
    await sleep(Math.min(step, ms - waited));
    waited += step;
  }
}

// A grid's own image count can still be climbing right after its dialog
// mounts (React populating "This project" from scratch), which makes a
// single count snapshot unreliable — it can look identical to "a fresh
// upload just landed" when it's really just the initial render finishing.
// Wait until the count hasn't changed for `quietMs` before trusting it.
async function waitForStableCount(
  getCount: () => number,
  label: string,
  quietMs = 800,
  timeoutMs = UPLOAD_WAIT_TIMEOUT_MS
): Promise<number> {
  const start = Date.now();
  let lastCount = getCount();
  let lastChangeAt = Date.now();
  let lastLoggedTick = -1;
  while (Date.now() - start < timeoutMs && !aborted) {
    await sleep(WAIT_INTERVAL_MS);
    const count = getCount();
    if (count !== lastCount) {
      log(label, 'count changed', lastCount, '->', count, '— still settling');
      lastCount = count;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietMs) {
      log(label, 'count stable at', lastCount);
      return lastCount;
    }
    const tick = Math.floor((Date.now() - start) / 2000);
    if (tick !== lastLoggedTick) {
      log(label, 'still settling, currently', lastCount, 'after', tick * 2, 's');
      lastLoggedTick = tick;
    }
  }
  return lastCount;
}

// Radix triggers/menu items commonly open on `pointerdown`, not `click`.
// `Element.click()` only fires a `click` event — it skips pointerdown/mouseup,
// so it silently no-ops on those components. Dispatch the full sequence.
// Some tap/drag libraries (grid tiles, Framer Motion-style press handlers)
// validate the pointer coordinates against the element's own bounds instead
// of trusting bubbled events blindly — a synthetic event with clientX/Y at
// 0,0 can silently fail their hit-test. Center the coordinates on the real
// element so those checks pass too.
//
// Every click is followed by a random 1-2s pause: firing this whole flow's
// actions back-to-back (mode switch, upload, tile select, generate...) is
// what was tripping vibes.ai's own rate limiting across scenes.
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
  await sleep(1000 + Math.random() * 1000);
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

function findButtonByText(scope: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent?.trim() === text
    ) ?? null
  );
}

// vibes.ai's picker/upload dialogs aren't marked with role="dialog" in the
// markup we inspected, so there's no reliable container selector. Instead we
// locate the dialog's own heading text and climb ancestors until `isDone`
// says we've reached a container that holds the whole dialog — that becomes
// the scope for all further queries, so we don't accidentally hit the
// blurred gallery sitting behind the modal.
//
// The default heuristic (>=2 img/button descendants) stops too early on
// "Select start frame": that dialog has a header (Upload nav button + close
// X — already 2 buttons) sitting as a SIBLING of the body that holds the
// actual image grid, so the climb would lock onto the header alone and miss
// the grid entirely. Callers that need the grid pass a stricter check.
function resolveDialogByHeadingSync(
  headingText: string,
  isDone: (node: HTMLElement) => boolean
): HTMLElement | null {
  const heading = Array.from(document.querySelectorAll<HTMLElement>('div,span,h1,h2,h3')).find(
    (el) => el.textContent?.trim() === headingText && el.children.length === 0
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
  headingText: string,
  isDone: (node: HTMLElement) => boolean = (node) =>
    node.querySelectorAll('img, button').length >= 2,
  timeoutMs = UPLOAD_WAIT_TIMEOUT_MS
): Promise<HTMLElement | null> {
  return waitFor(() => resolveDialogByHeadingSync(headingText, isDone), timeoutMs);
}

// "Add to video" only exists once, at the very bottom of the full "Select
// start frame" modal — a reliable marker of the complete dialog regardless
// of how many images are currently in the grid (even zero).
const hasAddToVideoButton = (node: HTMLElement) => !!findButtonByText(node, 'Add to video');

// ── Mode switch (Video/Image/Lip sync toggle) ─────────────────────────────────

// The composer's contenteditable swaps its aria-label between
// "Describe an image..." and "Describe a video..." depending on which mode
// (Video/Image/Lip sync) is currently active — this is the only reliable
// signal for current mode, since the same label text ("Video"/"Image")
// appears both on the mode-toggle trigger and inside its dropdown menu.
function getCurrentMode(): 'image' | 'video' | null {
  const composer = document.querySelector<HTMLElement>(ComposerSelectors.Input);
  const label = composer?.getAttribute('aria-label') ?? composer?.getAttribute('title') ?? '';
  if (label.includes('image')) return BatchModes.Image;
  if (label.includes('video')) return BatchModes.Video;
  return null;
}

// Trigger button for the mode dropdown looks identical (text-wise) to the
// items inside its own menu ("Video" / "Image"). Distinguish it by: it's not
// a menuitem, and it's wrapped by the radix dropdown trigger container
// (aria-haspopup="menu"). The other such trigger on the toolbar is
// "Ingredients", filtered out by the label check.
function findModeTriggerButton(): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  return (
    buttons.find((btn) => {
      if (btn.getAttribute('role') === 'menuitem') return false;
      const label = btn.querySelector('span')?.textContent?.trim();
      if (label !== 'Video' && label !== 'Image') return false;
      return !!btn.closest('[aria-haspopup="menu"]');
    }) ?? null
  );
}

async function openModeMenu(): Promise<HTMLElement | null> {
  const trigger = findModeTriggerButton();
  log('trigger found?', !!trigger, trigger?.textContent?.trim());
  if (!trigger) return null;
  await simulateClick(trigger);
  const menu = await waitFor(() =>
    document.querySelector<HTMLElement>('[role="menu"][data-state="open"]')
  );
  log('menu opened?', !!menu);
  return menu;
}

async function clickMenuItem(menu: HTMLElement, target: 'image' | 'video'): Promise<boolean> {
  const wanted = target === BatchModes.Image ? 'Image' : 'Video';
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
  const item = items.find((btn) => {
    const text = btn.querySelector('span.flex_1')?.textContent?.trim() ?? btn.textContent?.trim();
    return text === wanted;
  });
  log('item found?', !!item, wanted);
  if (!item) return false;
  await simulateClick(item);
  return true;
}

async function ensureMode(target: 'image' | 'video'): Promise<boolean> {
  const before = getCurrentMode();
  log('current mode before', before, '-> target', target);
  if (before === target) return true;

  const menu = await openModeMenu();
  if (!menu) return false;

  if (!(await clickMenuItem(menu, target))) return false;

  const result = await waitFor(() => (getCurrentMode() === target ? true : null));
  log('current mode after', getCurrentMode(), 'switched?', result === true);
  return result === true;
}

// Right after the composer node appears (page just loaded, or mode switch
// just swapped it), Lexical hasn't finished wiring its own event handlers
// yet. execCommand('insertText') run in that window lands at the DOM level
// but Lexical silently reverts it since the change didn't go through its own
// input pipeline — so the Generate button never enables. Resolving against
// the aria-label that matches the target mode (instead of "any composer")
// guarantees we grab the post-switch node, and the retry loop below covers
// the remaining "not wired up yet" race.
async function getSettledComposer(
  target: 'image' | 'video',
  timeoutMs = 5000
): Promise<HTMLElement | null> {
  return waitFor(() => {
    const composer = document.querySelector<HTMLElement>(ComposerSelectors.Input);
    const label = composer?.getAttribute('aria-label') ?? composer?.getAttribute('title') ?? '';
    const wanted = target === BatchModes.Image ? 'image' : 'video';
    return composer && label.includes(wanted) ? composer : null;
  }, timeoutMs);
}

async function fillComposer(composer: HTMLElement, prompt: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    composer.focus();
    document.execCommand('insertText', false, prompt);
    await sleep(200);
    if ((composer.textContent ?? '').trim().length > 0) {
      log('composer filled on attempt', attempt + 1);
      return true;
    }
    log('composer still empty after attempt', attempt + 1, '- retrying');
  }
  return false;
}

// ── Start/end frame attachment (video mode only) ──────────────────────────────

// Video generation requires a start frame chosen through a 3-step dialog:
// 1. toggle the "Start, end frame" panel open, click "Add start frame"
// 2. in the "Select start frame" picker, click "Upload" and drop the file in
//    the nested "Upload images" dialog, then confirm its own "Upload" button
// 3. back in the picker, click the freshly-uploaded tile (identified by its
//    alt text matching the uploaded filename) and confirm with "Add to video"
async function ensureStartEndFramePanel(): Promise<boolean> {
  if (findButtonByText(document, 'Add start frame')) return true;

  const toggle = document.querySelector<HTMLButtonElement>(StartEndFrameSelectors.Toggle);
  log('start/end frame toggle found?', !!toggle);
  if (!toggle) return false;
  await simulateClick(toggle);

  const found = await waitFor(() => findButtonByText(document, 'Add start frame'));
  return !!found;
}

// Radix-style dialogs on this site close on Escape regardless of which one
// is open, so this is a generic "give up cleanly" hatch — used whenever
// attachStartFrame bails partway through, so a leftover open dialog doesn't
// leak into the next scene's attempt (e.g. its stale tiles getting matched).
function closeAnyOpenDialog() {
  const opts = { bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', ...opts }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', ...opts }));
}

// After sending a video prompt, vibes.ai keeps the "Start frame" thumbnail
// attached to the composer for next time — clear it so the next scene
// attaches its own reference image instead of silently reusing this one.
async function removeStartFrame(): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Remove start frame"]');
  if (!btn) {
    log('no "Remove start frame" button found — nothing to clear');
    return;
  }
  await simulateClick(btn);
  log('start frame removed after sending prompt');
}

// The global "Upload failed" toast is a real server-side failure signal
// (distinct from the always-instant-enabled local confirm button), and like
// the generation-error toast, stays in the DOM after the fact — so this is
// counted and compared against a per-attempt baseline rather than just
// checked for existence, to avoid a stale toast from a previous attempt
// falsely failing a later, actually-successful one.
function countUploadFailedToasts(): number {
  return Array.from(document.querySelectorAll<HTMLElement>('span')).filter(
    (el) => el.textContent?.trim() === 'Upload failed'
  ).length;
}

const MAX_UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 8000;

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

  const uploadNavBtn = findButtonByText(pickerDialog, 'Upload');
  if (!uploadNavBtn) {
    log('picker "Upload" nav button not found');
    return { status: 'failed' };
  }
  await simulateClick(uploadNavBtn);

  const uploadDialog = await findDialogByHeading('Upload images');
  if (!uploadDialog) {
    log('"Upload images" dialog not found');
    return { status: 'failed' };
  }

  const fileInput =
    uploadDialog.querySelector<HTMLInputElement>('input[type="file"]') ??
    document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) {
    log('file input not found in upload dialog');
    return { status: 'failed' };
  }

  const file = dataURLtoFile(imageBase64, imageName);
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  // The confirm button enables in the SAME tick as this dispatch (confirmed
  // via logs) — clicking it immediately means "attach file" and "confirm
  // upload" fire back-to-back with zero gap, which is what was triggering
  // vibes.ai's rate limiting. Force a real pause here regardless of how fast
  // the button itself becomes clickable.
  await sleep(1500 + Math.random() * 1000);

  // Confirm as soon as it's clickable — this is the normal, expected click
  // (it's what a real user would do too); it does not mean upload finished.
  const confirmBtn = await waitFor(() => {
    const btn = findButtonByText(uploadDialog, 'Upload');
    return btn && !btn.disabled ? btn : null;
  });
  if (!confirmBtn) {
    log('upload confirm button never became clickable');
    return { status: 'failed' };
  }
  await simulateClick(confirmBtn);

  const pickerDialogAfter = await findDialogByHeading('Select start frame', hasAddToVideoButton);
  if (!pickerDialogAfter) {
    log('picker dialog not found after upload');
    return { status: 'failed' };
  }

  // pickerDialogAfter can go stale mid-wait: vibes.ai can remount the
  // "Select start frame" dialog again after this point (e.g. swapping the
  // temp upload preview for the final CDN thumbnail), which detaches this
  // reference from the live document — querying it further just replays
  // whatever count it had at the moment of detachment, forever, instead of
  // the real live state. Re-resolve the dialog fresh on every check instead
  // of trusting one captured reference. A single stable reading isn't
  // enough either: right after confirming, the grid can be legitimately
  // stable AT the baseline for several seconds while the real upload is
  // still in flight. Keep re-checking (each check itself waiting for its
  // own settle window, capped short so we can also notice an "Upload
  // failed" toast in between) until it stabilizes ABOVE baseline, a failure
  // toast appears, or we run out of time.
  const getLiveDialog = () => resolveDialogByHeadingSync('Select start frame', hasAddToVideoButton);
  const getLiveCount = () => getLiveDialog()?.querySelectorAll('img[data-nimg="fill"]').length ?? 0;

  log('waiting for post-upload grid to exceed baseline of', baselineTotalImages, 'images');
  const deadline = Date.now() + UPLOAD_WAIT_TIMEOUT_MS;
  let finalCount = baselineTotalImages;
  while (Date.now() < deadline) {
    if (aborted) return { status: 'aborted' };
    if (countUploadFailedToasts() > uploadFailBaseline) {
      log('"Upload failed" toast detected');
      return { status: 'failed' };
    }

    finalCount = await waitForStableCount(
      getLiveCount,
      'post-upload grid',
      800,
      Math.min(3000, deadline - Date.now())
    );
    if (finalCount > baselineTotalImages) {
      const liveDialog = getLiveDialog() ?? pickerDialogAfter;
      return { status: 'success', pickerDialogAfter: liveDialog, finalCount };
    }
    if (countUploadFailedToasts() > uploadFailBaseline) {
      log('"Upload failed" toast detected');
      return { status: 'failed' };
    }
    log(
      'post-upload grid at',
      finalCount,
      'vs baseline',
      baselineTotalImages,
      '— real upload still pending, rechecking'
    );
    await sleep(500);
  }
  log(
    'grid image count (',
    finalCount,
    ') never exceeded baseline (',
    baselineTotalImages,
    ') within the timeout'
  );
  return { status: 'failed' };
}

async function attachStartFrame(imageBase64: string, imageName: string): Promise<boolean> {
  const result = await attachStartFrameAttempt(imageBase64, imageName);
  if (!result) {
    log('attachStartFrame failed — closing any leftover dialog before giving up');
    closeAnyOpenDialog();
    await sleep(300);
  }
  return result;
}

async function attachStartFrameAttempt(imageBase64: string, imageName: string): Promise<boolean> {
  if (!(await ensureStartEndFramePanel())) {
    log('start/end frame panel never opened');
    return false;
  }

  const addStartBtn = findButtonByText(document, 'Add start frame');
  if (!addStartBtn) return false;
  await simulateClick(addStartBtn);

  const pickerDialog = await findDialogByHeading('Select start frame', hasAddToVideoButton);
  if (!pickerDialog) {
    log('"Select start frame" dialog not found');
    return false;
  }

  // The confirm "Upload" button inside the nested dialog enables the instant
  // a local file is attached — it is NOT a signal that the real network
  // upload finished (confirmed: it flips to disabled=false in the very same
  // tick as the file input's change event, no network round-trip involved).
  // The only trustworthy signal is the picker grid's own image count
  // actually growing — but take that baseline only once the grid's own
  // initial render has settled, or a still-populating "This project" tab
  // looks identical to a fresh upload landing.
  const baselineTotalImages = await waitForStableCount(
    () => pickerDialog.querySelectorAll('img[data-nimg="fill"]').length,
    'baseline grid'
  );

  let uploadResult: UploadAttemptResult = { status: 'failed' };
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    if (aborted) {
      uploadResult = { status: 'aborted' };
      break;
    }
    uploadResult = await attemptUpload(pickerDialog, imageBase64, imageName, baselineTotalImages);
    if (uploadResult.status !== 'failed') break;
    if (attempt >= MAX_UPLOAD_ATTEMPTS) break;
    log('upload attempt', attempt, 'failed — retrying in', UPLOAD_RETRY_DELAY_MS / 1000, 's');
    await sleepAbortable(UPLOAD_RETRY_DELAY_MS);
  }

  if (uploadResult.status !== 'success') {
    log('start frame upload never succeeded after', MAX_UPLOAD_ATTEMPTS, 'attempts');
    return false;
  }

  const { pickerDialogAfter, finalCount } = uploadResult;
  log(
    'grid image count grew from',
    baselineTotalImages,
    'to',
    finalCount,
    '— fresh upload should now be the first tile'
  );

  const selected = await selectFirstTile(pickerDialogAfter);
  if (!selected) {
    log('could not select the first tile with any click strategy');
    return false;
  }

  const addToVideoBtn = findButtonByText(pickerDialogAfter, 'Add to video');
  if (!addToVideoBtn || addToVideoBtn.disabled) {
    log('"Add to video" not enabled after selecting the tile');
    return false;
  }
  await simulateClick(addToVideoBtn);

  return true;
}

// Selecting a tile just toggles a CSS class (blue border) picked up from
// component state — there's no visible attribute we can poll for directly.
// The "Add to video" button unlocking is the real, observable proof the
// click landed, so each strategy is tried and checked against that before
// moving to the next. Needed because a fully synthetic pointer/mouse
// sequence sometimes isn't enough for whatever gesture recognizer this grid
// uses (Framer Motion-style tap handlers are known to be picky about this).
async function selectFirstTile(pickerDialog: HTMLElement): Promise<boolean> {
  const findFirstTile = (): { tile: HTMLElement; img: HTMLImageElement } | null => {
    const img = pickerDialog.querySelector<HTMLImageElement>('img[data-nimg="fill"]');
    if (!img) return null;
    const tile = img.closest<HTMLElement>('div') ?? img.parentElement;
    return tile ? { tile, img } : null;
  };

  const first = await waitFor(findFirstTile, UPLOAD_WAIT_TIMEOUT_MS);
  if (!first) {
    log('no tile found in picker grid at all');
    return false;
  }
  log('first tile in grid — alt:', first.img.alt);

  const isAddToVideoEnabled = () => {
    const btn = findButtonByText(pickerDialog, 'Add to video');
    return !!btn && !btn.disabled;
  };

  const strategies: Array<(el: { tile: HTMLElement; img: HTMLImageElement }) => Promise<void>> = [
    ({ tile }) => simulateClick(tile),
    async ({ tile }) => {
      tile.click();
      await sleep(1000 + Math.random() * 1000);
    },
    ({ img }) => simulateClick(img),
    async ({ img }) => {
      img.click();
      await sleep(1000 + Math.random() * 1000);
    },
  ];

  for (const [i, strategy] of strategies.entries()) {
    const target = findFirstTile();
    if (!target) {
      log('first tile detached before click strategy', i + 1, 'could fire');
      return false;
    }
    await strategy(target);
    const result = await waitFor(() => (isAddToVideoEnabled() ? true : null), 2500);
    if (result) {
      log('tile selected via click strategy', i + 1);
      return true;
    }
    log('click strategy', i + 1, 'did not enable "Add to video", trying next');
  }

  return false;
}

// ── Gallery polling (shared by image and video generation) ───────────────────

interface ReadyThumbnail {
  mediaId: string;
  batchId: string;
  index: number;
  url: string;
}

// data-analytics-media-id looks like "batch-<uuid>-content-<n>". The uuid
// itself contains dashes, so split on the "-content-" separator instead of
// trying to pattern-match the uuid shape. A card counts as "ready" once it
// holds a loaded <img> (image mode) or a <video src> (video mode) instead of
// the loading skeleton (a bare <canvas>).
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

// vibes.ai shows this inline card in place of a thumbnail when a generation
// errors out (rate limit, content policy, etc.) — for either image or video.
// It stays in the DOM even after a later retry succeeds, so a plain
// "does one exist?" check would keep re-triggering on a stale card from an
// earlier attempt. Counting them and comparing against a baseline taken
// right before each attempt is what tells a NEW failure apart from an old one.
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
  sceneNumber: number,
  errorBaseline: number
): Promise<MediaPollResult> {
  for (let attempts = 0; attempts < MEDIA_POLL_MAX_ATTEMPTS; attempts++) {
    if (aborted) return { status: 'aborted' };
    if (countGenerationErrors() > errorBaseline) return { status: 'error' };

    const batchMedia = findNewBatch(beforeIds);
    if (batchMedia) {
      log(
        'scene',
        sceneNumber,
        'batch detected, waiting',
        MEDIA_STABILIZE_MS / 1000,
        's for the CDN file to settle before downloading'
      );
      await sleepAbortable(MEDIA_STABILIZE_MS);
      if (aborted) return { status: 'aborted' };
      // Re-read the src right before downloading — if the CDN swapped the
      // file out from under the thumbnail during the settle window, this
      // picks up the final one instead of the stale reference.
      const urls = batchMedia.map((t) => getUrlByMediaId(t.mediaId) ?? t.url);
      return { status: 'success', urls };
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }
  return { status: 'timeout' };
}

const MAX_GENERATION_ATTEMPTS = 3;
const GENERATION_RETRY_DELAY_MS = 20000;

// On "Couldn't generate", vibes.ai's own flakiness (not the prompt) is the
// usual culprit — the same prompt often succeeds on a plain retry. Wait,
// re-click Generate (reusing whatever's already in the composer), and only
// give up after MAX_GENERATION_ATTEMPTS straight failures.
async function generateWithRetries(
  beforeIds: Set<string>,
  sceneNumber: number,
  clickGenerate: () => Promise<boolean>
) {
  let errorBaseline = countGenerationErrors();

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    if (aborted) {
      log('scene', sceneNumber, 'batch stopped — abandoning mid-generation');
      return;
    }

    const result = await waitForMediaBatch(beforeIds, sceneNumber, errorBaseline);

    if (result.status === 'aborted') {
      log('scene', sceneNumber, 'batch stopped — abandoning mid-generation');
      return;
    }

    if (result.status === 'success') {
      log('scene', sceneNumber, 'ready, urls', result.urls);
      await browser.runtime.sendMessage({
        action: Actions.DownloadMediaDirect,
        urls: result.urls,
        sceneNumber,
      });
      return;
    }

    if (result.status === 'timeout') {
      log('media poll timed out for scene', sceneNumber);
      return;
    }

    // status === 'error'
    if (attempt >= MAX_GENERATION_ATTEMPTS) {
      log(
        'scene',
        sceneNumber,
        'still failing after',
        attempt,
        'attempts — skipping to next scene'
      );
      await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
      return;
    }

    log(
      'scene',
      sceneNumber,
      '"Couldn\'t generate" on attempt',
      attempt,
      '— retrying same prompt in',
      GENERATION_RETRY_DELAY_MS / 1000,
      's'
    );
    await sleepAbortable(GENERATION_RETRY_DELAY_MS);
    if (aborted) {
      log('scene', sceneNumber, 'batch stopped during retry wait — abandoning');
      return;
    }

    // Reset the baseline to include the error(s) we just handled, so the
    // NEXT attempt's check only fires on a genuinely new failure card
    // instead of re-tripping on this one forever.
    errorBaseline = countGenerationErrors();

    const clicked = await clickGenerate();
    if (!clicked) {
      log('scene', sceneNumber, 'retry could not click Generate — skipping to next scene');
      await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
      return;
    }
  }
}

// ── Mode handlers ──────────────────────────────────────────────────────────────

async function handleImageMode(
  prompt: string,
  sceneNumber: number | undefined,
  sendResponse: (r: ContentResponse) => void
) {
  const switched = await ensureMode(BatchModes.Image);
  if (!switched) {
    sendResponse({ success: false, error: 'No se pudo activar el modo image.' });
    return;
  }

  const composer = await getSettledComposer(BatchModes.Image);
  if (!composer) {
    sendResponse({ success: false, error: 'Composer no encontrado tras cambiar de modo.' });
    return;
  }

  const filled = await fillComposer(composer, prompt);
  if (!filled) {
    sendResponse({ success: false, error: 'No se pudo escribir el prompt en el composer.' });
    return;
  }

  const beforeIds = new Set(getReadyThumbnails().map((t) => t.mediaId));

  const clickGenerate = async (): Promise<boolean> => {
    // Defensive: a failed generation can leave the composer empty.
    if ((composer.textContent ?? '').trim().length === 0) {
      if (!(await fillComposer(composer, prompt))) return false;
    }
    // A small buffer before hitting Generate — clicking the instant it
    // enables, scene after scene, is what triggers vibes.ai's rate limiting.
    await sleep(800);
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
  const switched = await ensureMode(BatchModes.Video);
  if (!switched) {
    sendResponse({ success: false, error: 'No se pudo activar el modo video.' });
    return;
  }

  if (imageBase64 && imageName) {
    const attached = await attachStartFrame(imageBase64, imageName);
    if (!attached) {
      sendResponse({ success: false, error: 'No se pudo adjuntar el start frame.' });
      return;
    }
  }

  const composer = await getSettledComposer(BatchModes.Video);
  if (!composer) {
    sendResponse({ success: false, error: 'Composer no encontrado tras cambiar de modo.' });
    return;
  }

  const filled = await fillComposer(composer, prompt);
  if (!filled) {
    sendResponse({ success: false, error: 'No se pudo escribir el prompt en el composer.' });
    return;
  }

  const beforeIds = new Set(getReadyThumbnails().map((t) => t.mediaId));

  const clickGenerate = async (): Promise<boolean> => {
    // Defensive: a failed generation can leave the composer empty. The
    // start frame itself is untouched by a failed attempt, so no need to
    // re-attach it here — only removed once this scene is fully done below.
    if ((composer.textContent ?? '').trim().length === 0) {
      if (!(await fillComposer(composer, prompt))) return false;
    }
    // A small buffer before hitting Generate — clicking the instant it
    // enables, scene after scene, is what triggers vibes.ai's rate limiting.
    await sleep(800);
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

  // Only clear the start frame once we're fully done with this scene
  // (success, timeout, or exhausted retries) — a retry needs it still
  // attached to regenerate the same video. Left alone after that, the next
  // scene would silently reuse THIS scene's reference image instead of its
  // own.
  await removeStartFrame();
}

export default defineContentScript({
  matches: ['*://*.vibes.ai/*', '*://vibes.ai/*'],
  main() {
    log('content script loaded — build', CONTENT_SCRIPT_BUILD);
    browser.runtime.onMessage.addListener(
      (message: ExtensionMessage, _sender, sendResponse: (r: ContentResponse) => void) => {
        if (message.action === Actions.StopBatch) {
          aborted = true;
          log('batch stop received — aborting in-flight work');
          return false;
        }

        if (message.action !== Actions.FillPrompt) return false;

        // A fresh scene command means the batch is active again (e.g. a new
        // batch started after a previous one was stopped) — clear any stale
        // abort flag so this scene isn't dead on arrival.
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
