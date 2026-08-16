import { LogKinds, LogLevels } from '../../lib/types';
import { StartEndFrameSelectors } from '../../lib/selectors/vibes';
import {
  MAX_UPLOAD_ATTEMPTS,
  UPLOAD_RETRY_DELAY_MS,
  MAX_CONFIRM_ATTEMPTS,
  CONFIRM_CLOSE_TIMEOUT_MS,
  UPLOAD_WAIT_TIMEOUT_MS,
  ADD_FRAME_ICON_PATH,
  UPLOAD_ICON_PATH,
  SELECTED_TILE_MARKER,
  ADD_TO_VIDEO_BUTTON_CLASS,
  CLOSE_ICON_PATH,
  REMOVE_FRAME_BUTTON_SIZE_CLASS,
} from './constants';
import { aborted } from './abortState';
import { log } from './log';
import { sleep, sleepAbortable, simulateClick, waitFor, dataURLtoFile } from './domUtils';

function findAddToVideoButton(dialog: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
      btn.className.includes(ADD_TO_VIDEO_BUTTON_CLASS)
    ) ?? null
  );
}

const getUploadedImages = (scope: ParentNode) =>
  scope.querySelectorAll<HTMLImageElement>('img[data-nimg="fill"]');

function findUploadNavButton(scope: ParentNode): HTMLButtonElement | null {
  return (
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((btn) =>
      Array.from(btn.querySelectorAll('svg path')).some((p) =>
        (p.getAttribute('d') ?? '').startsWith(UPLOAD_ICON_PATH)
      )
    ) ?? null
  );
}

// Every other button in this dialog has an aria-label; the confirm action
// doesn't — that's what picks it out, language-independently.
function findUploadConfirmButton(dialog: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => !btn.hasAttribute('aria-label')
    ) ?? null
  );
}

// Right after clicking "Add start frame", exactly one dialog is open (the picker).
function waitForOpenDialog(timeoutMs = UPLOAD_WAIT_TIMEOUT_MS): Promise<HTMLElement | null> {
  return waitFor(
    () => document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]'),
    timeoutMs
  );
}

// The upload sub-dialog opens stacked on top of the (still open) picker —
// just grab whichever open dialog isn't the one we already have.
function waitForOtherOpenDialog(
  exclude: HTMLElement,
  timeoutMs = UPLOAD_WAIT_TIMEOUT_MS
): Promise<HTMLElement | null> {
  return waitFor(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]')).find(
        (d) => d !== exclude
      ) ?? null,
    timeoutMs
  );
}

// Start/end frame buttons share one icon — the *enabled* one is always "Add
// start frame" ("end" stays disabled until a start frame exists).
function findAddStartFrameButton(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) =>
        !btn.disabled &&
        Array.from(btn.querySelectorAll('svg path')).some((p) =>
          (p.getAttribute('d') ?? '').startsWith(ADD_FRAME_ICON_PATH)
        )
    ) ?? null
  );
}

// ── Start-frame attachment (video mode) ───────────────────────────────────────

async function ensureStartEndFramePanel(): Promise<HTMLButtonElement | null> {
  const existing = findAddStartFrameButton();
  if (existing) return existing;
  const toggle = document.querySelector<HTMLButtonElement>(StartEndFrameSelectors.Toggle);
  if (!toggle) return null;
  await simulateClick(toggle);
  return waitFor(() => findAddStartFrameButton());
}

function closeAnyOpenDialog() {
  const opts = { bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', ...opts }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', ...opts }));
}

export async function removeStartFrame(): Promise<void> {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (el) =>
      el.className.includes(REMOVE_FRAME_BUTTON_SIZE_CLASS) &&
      Array.from(el.querySelectorAll('svg path')).some((p) =>
        (p.getAttribute('d') ?? '').startsWith(CLOSE_ICON_PATH)
      )
  );
  if (!btn) return;
  await simulateClick(btn);
}

const UploadResults = {
  Success: 'success',
  Failed: 'failed',
  Aborted: 'aborted',
} as const;

type UploadAttemptResult =
  | { status: typeof UploadResults.Success; pickerDialogAfter: HTMLElement }
  | { status: typeof UploadResults.Failed }
  | { status: typeof UploadResults.Aborted };

// Confirm enables once the file preview lands — real readiness signal.
// Success closes the dialog on its own; if a click doesn't (the confirm
// button re-enables itself when that happens), just re-click it — the file
// is already staged, no need to redo the whole attempt for that.
async function confirmUpload(
  uploadDialog: HTMLElement
): Promise<
  typeof UploadResults.Success | typeof UploadResults.Failed | typeof UploadResults.Aborted
> {
  for (let confirmAttempt = 1; confirmAttempt <= MAX_CONFIRM_ATTEMPTS; confirmAttempt++) {
    const confirmBtn = await waitFor(() => {
      const btn = findUploadConfirmButton(uploadDialog);
      return btn && !btn.disabled ? btn : null;
    });
    if (aborted) return UploadResults.Aborted;
    if (!confirmBtn) return UploadResults.Failed;
    await simulateClick(confirmBtn);

    const closed = await waitFor(
      () => (document.body.contains(uploadDialog) ? null : true),
      CONFIRM_CLOSE_TIMEOUT_MS
    );
    if (aborted) return UploadResults.Aborted;
    if (closed) return UploadResults.Success;
  }
  return UploadResults.Failed;
}

async function attemptUpload(imageBase64: string, imageName: string): Promise<UploadAttemptResult> {
  // Re-resolved fresh each call (not passed in) — vibes.ai can remount the
  // picker between retries.
  const pickerDialog = await waitForOpenDialog();
  if (aborted) return { status: UploadResults.Aborted };
  if (!pickerDialog) return { status: UploadResults.Failed };

  const uploadNavBtn = findUploadNavButton(pickerDialog);
  if (!uploadNavBtn) return { status: UploadResults.Failed };
  await simulateClick(uploadNavBtn);

  const uploadDialog = await waitForOtherOpenDialog(pickerDialog);
  if (aborted) return { status: UploadResults.Aborted };
  if (!uploadDialog) return { status: UploadResults.Failed };

  const fileInput =
    uploadDialog.querySelector<HTMLInputElement>('input[type="file"]') ??
    document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) return { status: UploadResults.Failed };

  // imageName (e.g. "scene_0002.jpeg") is deterministic per scene — a prior
  // run could've already left a same-named file in this vibes.ai project, so
  // upload under a unique name instead to unambiguously find *this* upload.
  const uploadName = `${crypto.randomUUID()}-${imageName}`;
  const file = dataURLtoFile(imageBase64, uploadName);
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('input', { bubbles: true }));
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  const confirmResult = await confirmUpload(uploadDialog);
  if (confirmResult !== UploadResults.Success) return { status: confirmResult };

  // Back to exactly one open dialog (the picker), same as the first lookup.
  const pickerDialogAfter = await waitForOpenDialog();
  if (aborted) return { status: UploadResults.Aborted };
  if (!pickerDialogAfter) return { status: UploadResults.Failed };

  // Look for the specific file we uploaded, by its alt (= filename) — the
  // grid can be virtualized/lazy, so a total image count fluctuates on its
  // own and isn't a reliable "did it land" signal.
  const escapedName = CSS.escape(uploadName);
  const uploadedImage = await waitFor(
    () => pickerDialogAfter.querySelector<HTMLImageElement>(`img[alt="${escapedName}"]`),
    UPLOAD_WAIT_TIMEOUT_MS
  );
  if (aborted) return { status: UploadResults.Aborted };
  if (uploadedImage) {
    return { status: UploadResults.Success, pickerDialogAfter };
  }
  return { status: UploadResults.Failed };
}

function findFirstTile(pickerDialog: HTMLElement): HTMLElement | null {
  const img = getUploadedImages(pickerDialog)[0];
  if (!img) return null;
  return img.closest<HTMLElement>('div') ?? img.parentElement;
}

async function selectFirstTile(pickerDialog: HTMLElement): Promise<boolean> {
  const first = await waitFor(() => findFirstTile(pickerDialog), UPLOAD_WAIT_TIMEOUT_MS);
  if (!first) return false;

  await simulateClick(first);
  // Re-resolve on every poll instead of trusting `first`, in case the tile remounts.
  const result = await waitFor(
    () => (findFirstTile(pickerDialog)?.className.includes(SELECTED_TILE_MARKER) ? true : null),
    2500
  );
  return result === true;
}

// Owns the whole upload→check-result retry cycle, attempt 1 included.
async function uploadWithRetries(
  imageBase64: string,
  imageName: string,
  sceneNumber: number
): Promise<UploadAttemptResult> {
  let uploadResult: UploadAttemptResult = { status: UploadResults.Failed };

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    if (aborted) return { status: UploadResults.Aborted };

    log({
      sceneNumber,
      step: 'Subiendo start frame',
      kind: LogKinds.Info,
      level: LogLevels.Detail,
      attempt: { current: attempt, max: MAX_UPLOAD_ATTEMPTS },
      cooldownMs: UPLOAD_WAIT_TIMEOUT_MS,
    });
    uploadResult = await attemptUpload(imageBase64, imageName);

    switch (uploadResult.status) {
      case UploadResults.Success:
      case UploadResults.Aborted:
        return uploadResult;

      case UploadResults.Failed:
        if (attempt >= MAX_UPLOAD_ATTEMPTS) return uploadResult;
        break;
    }

    log({
      sceneNumber,
      step: 'Subida falló, reintentando',
      kind: LogKinds.Retry,
      level: LogLevels.Detail,
      attempt: { current: attempt, max: MAX_UPLOAD_ATTEMPTS },
      cooldownMs: UPLOAD_RETRY_DELAY_MS,
    });
    // A failed attempt can leave the upload dialog stuck open — close it
    // before retrying.
    closeAnyOpenDialog();
    await sleepAbortable(UPLOAD_RETRY_DELAY_MS);
  }
  return uploadResult;
}

export async function attachStartFrame(
  imageBase64: string,
  imageName: string,
  sceneNumber: number
): Promise<boolean> {
  log({
    sceneNumber,
    step: 'Adjuntando start frame',
    kind: LogKinds.Info,
    level: LogLevels.Step,
  });

  const addStartBtn = await ensureStartEndFramePanel();
  if (!addStartBtn) {
    log({
      sceneNumber,
      step: 'No se pudo adjuntar el start frame',
      kind: LogKinds.Error,
      level: LogLevels.Step,
    });
    return false;
  }
  await simulateClick(addStartBtn);

  const uploadResult = await uploadWithRetries(imageBase64, imageName, sceneNumber);
  if (uploadResult.status !== UploadResults.Success) {
    log({
      sceneNumber,
      step: 'No se pudo adjuntar el start frame',
      kind: LogKinds.Error,
      level: LogLevels.Step,
    });
    closeAnyOpenDialog();
    await sleep(300);
    return false;
  }

  log({
    sceneNumber,
    step: 'Start frame subido',
    kind: LogKinds.Success,
    level: LogLevels.Step,
  });

  const { pickerDialogAfter } = uploadResult;
  const selected = await selectFirstTile(pickerDialogAfter);
  if (!selected) return false;

  // Selection and the button's enabled state update separately, so poll
  // instead of assuming it's ready right after selectFirstTile resolves.
  const addToVideoBtn = await waitFor(() => {
    const btn = findAddToVideoButton(pickerDialogAfter);
    return btn && !btn.disabled ? btn : null;
  }, 2500);
  if (!addToVideoBtn) return false;
  await simulateClick(addToVideoBtn);

  return true;
}
