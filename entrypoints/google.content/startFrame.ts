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

// "Inicial" is always the first .frame-trigger ("Final" is the second).
function findInitialFrameTrigger(): HTMLElement | null {
  return document.querySelector<HTMLElement>('flow-ingredient-bar .frame-trigger button.empty-chip');
}

// Attached: the trigger's <button class="empty-chip"> is replaced by a
// <flow-image-ingredient-chip>. Scoped to the first .frame-trigger — "Final"
// gets its own chip once that's attached too.
function isStartFrameAttached(): boolean {
  const first = document.querySelector<HTMLElement>('flow-ingredient-bar .frame-trigger');
  return !!first?.querySelector('flow-image-ingredient-chip');
}

const UploadResults = {
  Success: 'success',
  Failed: 'failed',
  Aborted: 'aborted',
} as const;

type UploadResult = (typeof UploadResults)[keyof typeof UploadResults];

function findConfirmButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button.detail-add-to-prompt-btn');
}

// <img alt> is a fixed generic string, not the filename — match by
// .footer-title's text instead, then read that tile's own <img>.
function findUploadedTile(uploadName: string): HTMLElement | null {
  const footer = Array.from(document.querySelectorAll<HTMLElement>('.footer-title')).find(
    (el) => el.textContent?.trim() === uploadName
  );
  return footer?.closest<HTMLElement>('flow-tile-container') ?? null;
}

// Same readiness signal as getReadyImages() in mediaPolling.ts: data-media-id
// only shows up once Flow is done processing the upload.
function findUploadedMedia(uploadName: string): HTMLImageElement | null {
  const tile = findUploadedTile(uploadName);
  return tile?.querySelector<HTMLImageElement>('img[data-media-id]') ?? null;
}

async function confirmSelection(): Promise<UploadResult> {
  for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS; attempt++) {
    const confirmBtn = await waitFor(() => findConfirmButton());
    if (aborted) return UploadResults.Aborted;
    if (!confirmBtn) return UploadResults.Failed;
    await nativeClick(confirmBtn);

    const attached = await waitFor(
      () => (isStartFrameAttached() ? true : null),
      CONFIRM_CLOSE_TIMEOUT_MS
    );
    if (aborted) return UploadResults.Aborted;
    if (attached) {
      // Picker's overlay backdrop can linger a beat after attach registers,
      // still eating clicks/focus — wait for it to clear before returning.
      await waitFor(() => (document.querySelector('.cdk-overlay-backdrop') ? null : true), 5000);
      return UploadResults.Success;
    }
  }
  return UploadResults.Failed;
}

// Drag&drop uploads the file into the library but doesn't attach it as the
// start frame — that needs the trigger's own picker: open it, select the
// upload by name (skipping its own "upload file" step, already done), then
// confirm.
async function attemptUpload(imageBase64: string, imageName: string): Promise<UploadResult> {
  const trigger = findInitialFrameTrigger();
  if (!trigger) return UploadResults.Failed;

  trigger.scrollIntoView({ block: 'center', inline: 'center' });
  await sleepAbortable(300);
  if (aborted) return UploadResults.Aborted;

  // Unique name so later steps can unambiguously find this exact upload,
  // not a stale one from a prior run.
  const uploadName = `${crypto.randomUUID()}-${imageName}`;
  const file = await base64ToFile(imageBase64, uploadName);
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  const dragEventInit: DragEventInit = { bubbles: true, cancelable: true, dataTransfer };

  trigger.dispatchEvent(new DragEvent('dragenter', dragEventInit));
  trigger.dispatchEvent(new DragEvent('dragover', dragEventInit));
  trigger.dispatchEvent(new DragEvent('drop', dragEventInit));
  if (aborted) return UploadResults.Aborted;

  await waitFor(() => findUploadedMedia(uploadName), UPLOAD_WAIT_TIMEOUT_MS);
  if (aborted) return UploadResults.Aborted;
  // Element existing isn't the same as Angular being done reacting to it —
  // this flow is intermittent without a beat here before opening the picker.
  await sleepAbortable(500);
  if (aborted) return UploadResults.Aborted;

  await nativeClick(trigger);

  const option = await waitFor(() => findUploadedTile(uploadName), UPLOAD_WAIT_TIMEOUT_MS);
  if (aborted) return UploadResults.Aborted;
  if (!option) return UploadResults.Failed;
  await nativeClick(option);
  // Same reasoning — give the selection a beat to register before confirming.
  await sleepAbortable(500);
  if (aborted) return UploadResults.Aborted;

  return confirmSelection();
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
