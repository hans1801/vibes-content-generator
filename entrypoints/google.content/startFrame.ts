import { LogKinds, LogLevels } from '../../lib/types';
import { log } from './log';
import { aborted } from './abortState';
import { sleepAbortable, nativeClick, base64ToFile, waitFor } from './domUtils';
import {
  UPLOAD_WAIT_TIMEOUT_MS,
  MAX_UPLOAD_ATTEMPTS,
  UPLOAD_RETRY_DELAY_MS,
  MAX_CONFIRM_ATTEMPTS,
  CONFIRM_CLOSE_TIMEOUT_MS,
} from './constants';

// The "Inicial"/"Final" frame triggers are the only elements with this
// pattern on the page, always in that DOM order — Inicial is the first one.
// Once a start frame is attached, this trigger is replaced by a thumbnail
// button, so its absence alone isn't proof of anything — see
// isStartFrameAttached below for that.
function findInitialFrameTrigger(): HTMLElement | null {
  return document.querySelector<HTMLElement>('div[aria-haspopup="dialog"][aria-controls]');
}

// After attaching, "Inicial" becomes a thumbnail button with this marker
// instead of a dialog trigger.
function isStartFrameAttached(): boolean {
  return !!document.querySelector('button[data-card-open]');
}

function waitForOpenPopover(timeoutMs = UPLOAD_WAIT_TIMEOUT_MS): Promise<HTMLElement | null> {
  return waitFor(
    () => document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]'),
    timeoutMs
  );
}

function findFileInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]');
}

// Every other button in the popover (tabs, sort, upload) carries an icon —
// the confirm ("Add to prompt") button doesn't.
function findConfirmButton(popover: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(popover.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => !btn.querySelector('i')
    ) ?? null
  );
}

function findUploadedOption(popover: HTMLElement, uploadName: string): HTMLElement | null {
  const img = popover.querySelector<HTMLImageElement>(`img[alt="${CSS.escape(uploadName)}"]`);
  return img?.closest<HTMLElement>('[role="option"]') ?? null;
}

const UploadResults = {
  Success: 'success',
  Failed: 'failed',
  Aborted: 'aborted',
} as const;

type UploadResult = (typeof UploadResults)[keyof typeof UploadResults];

// Confirm closes the popover on success; if a click doesn't (rare), just
// re-click it — the file is already staged and selected.
async function confirmSelection(popover: HTMLElement): Promise<UploadResult> {
  for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS; attempt++) {
    const confirmBtn = await waitFor(() => findConfirmButton(popover));
    if (aborted) return UploadResults.Aborted;
    if (!confirmBtn) return UploadResults.Failed;
    await nativeClick(confirmBtn);

    const closed = await waitFor(
      () => (document.body.contains(popover) ? null : true),
      CONFIRM_CLOSE_TIMEOUT_MS
    );
    if (aborted) return UploadResults.Aborted;
    if (closed) return UploadResults.Success;
  }
  return UploadResults.Failed;
}

async function attemptUpload(imageBase64: string, imageName: string): Promise<UploadResult> {
  const trigger = findInitialFrameTrigger();
  if (!trigger) return UploadResults.Failed;
  await nativeClick(trigger);

  const popover = await waitForOpenPopover();
  if (aborted) return UploadResults.Aborted;
  if (!popover) return UploadResults.Failed;

  // The hidden global file input is already in the DOM — no need to click
  // the "Subir archivos multimedia" trigger, which would open the real OS
  // file picker (a modal our script can't dismiss) since it's a trusted
  // click. We inject the file directly instead.
  const fileInput = findFileInput();
  if (!fileInput) return UploadResults.Failed;

  // A prior run could've left a same-named file — upload under a unique
  // name to unambiguously find this exact upload.
  const uploadName = `${crypto.randomUUID()}-${imageName}`;
  const file = await base64ToFile(imageBase64, uploadName);
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('input', { bubbles: true }));
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));

  const option = await waitFor(
    () => findUploadedOption(popover, uploadName),
    UPLOAD_WAIT_TIMEOUT_MS
  );
  if (aborted) return UploadResults.Aborted;
  if (!option) return UploadResults.Failed;
  await nativeClick(option);

  return confirmSelection(popover);
}

async function uploadWithRetries(
  imageBase64: string,
  imageName: string,
  sceneNumber: number
): Promise<UploadResult> {
  let result: UploadResult = UploadResults.Failed;

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    if (aborted) return UploadResults.Aborted;

    log({
      sceneNumber,
      step: 'Subiendo start frame',
      kind: LogKinds.Info,
      level: LogLevels.Detail,
      attempt: { current: attempt, max: MAX_UPLOAD_ATTEMPTS },
      cooldownMs: UPLOAD_WAIT_TIMEOUT_MS,
    });
    result = await attemptUpload(imageBase64, imageName);

    switch (result) {
      case UploadResults.Success:
      case UploadResults.Aborted:
        return result;

      case UploadResults.Failed:
        if (attempt >= MAX_UPLOAD_ATTEMPTS) return result;
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
    // A failed attempt can leave the popover stuck open — click away to close it.
    document.body.click();
    await sleepAbortable(UPLOAD_RETRY_DELAY_MS);
  }
  return result;
}

// Idempotent — safe to call before every generation attempt, not just the
// first. A failed generation can reset the composer and drop the attached
// frame, so a retry needs it re-checked (and re-uploaded if it's gone)
// before resubmitting, or it'd send the prompt with no reference image.
export async function attachStartFrame(
  imageBase64: string,
  imageName: string,
  sceneNumber: number
): Promise<boolean> {
  if (isStartFrameAttached()) return true;

  log({ sceneNumber, step: 'Adjuntando start frame', kind: LogKinds.Info, level: LogLevels.Step });

  const result = await uploadWithRetries(imageBase64, imageName, sceneNumber);
  if (result !== UploadResults.Success) {
    log({
      sceneNumber,
      step: 'No se pudo adjuntar el start frame',
      kind: LogKinds.Error,
      level: LogLevels.Step,
    });
    return false;
  }

  log({ sceneNumber, step: 'Start frame subido', kind: LogKinds.Success, level: LogLevels.Step });
  return true;
}
