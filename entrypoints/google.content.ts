import { Actions, BatchModes, LogKinds } from '../lib/types';
import type { ExtensionMessage, ContentResponse, LogKind } from '../lib/types';

// ── Constants ────────────────────────────────────────────────────────────────

const MEDIA_POLL_INTERVAL_MS = 1500;
// Google Flow renders images faster than Vibes — a shorter stabilization
// window is sufficient.
const MEDIA_STABILIZE_MS = 3000;
// ~2 minutes maximum wait for generation.
const MEDIA_POLL_MAX_ATTEMPTS = 80;
const MAX_GENERATION_ATTEMPTS = 4;
const GENERATION_RETRY_DELAY_MS = 20000;

// ── Abort flag ────────────────────────────────────────────────────────────────

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sleepAbortable(ms: number) {
  const step = 500;
  let waited = 0;
  while (waited < ms && !aborted) {
    await sleep(Math.min(step, ms - waited));
    waited += step;
  }
}

// Uses the Chrome Debugger API to dispatch a trusted (isTrusted=true) mouse
// click, which is required to pass Google Flow's synthetic-event guards.
async function nativeClick(element: HTMLElement): Promise<void> {
  const rect = element.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  await browser.runtime.sendMessage({ action: Actions.NativeClick, x, y });
  await sleep(300);
}

// Utilidad para convertir base64 a File real (necesario para inyectarlo en DataTransfer)
async function base64ToFile(base64: string, filename: string): Promise<File> {
  const res = await fetch(base64);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type });
}

// Google Flow uses Slate.js which validates the origin of input events. The
// only reliable way to insert text and files is via a DataTransfer drop event at the
// center coordinates of the editor node.
async function fillSlateComposer(
  composer: HTMLElement,
  prompt: string,
  file?: File
): Promise<boolean> {
  const expected = prompt.trim();

  for (let attempt = 0; attempt < 4; attempt++) {
    composer.focus();

    const rect = composer.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', prompt);
    if (file) {
      dataTransfer.items.add(file);
    }

    const targetNode = composer.querySelector('span[data-slate-string="true"]') ?? composer;
    targetNode.dispatchEvent(
      new DragEvent('drop', { dataTransfer, clientX, clientY, bubbles: true, cancelable: true })
    );
    targetNode.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true })
    );

    // execCommand as a secondary fallback in case the drop was rejected.
    document.execCommand('insertText', false, prompt);
    composer.dispatchEvent(new Event('input', { bubbles: true }));

    await sleep(400);

    // Si hay archivo (video), el contenido de texto exacto puede variar porque Slate
    // inserta un bloque de imagen, por lo que asumimos éxito si no lanza error.
    if (file) return true;
    if ((composer.textContent ?? '').trim().includes(expected)) return true;
  }

  return false;
}

function findButtonByTextSubstring(text: string, exact: boolean = false): HTMLElement | null {
  return Array.from(
    document.querySelectorAll('button, div[role="button"], span[role="button"]')
  ).find((el) => {
    if ((el as HTMLElement).offsetParent === null) return false;
    const elText = el.textContent?.trim().toLowerCase() ?? '';
    return exact ? elText === text.toLowerCase() : elText.includes(text.toLowerCase());
  }) as HTMLElement | null;
}

// Intenta cambiar la interfaz de Google Flow a modo "Video" si está en "Image"
async function switchToVideoMode(): Promise<boolean> {
  // Busca el botón de configuración que suele decir "Video | x1" o "Image"
  const settingsBtn =
    findButtonByTextSubstring('Video | x1') ||
    findButtonByTextSubstring('Video') ||
    findButtonByTextSubstring('Image');

  if (!settingsBtn) return false;
  if (settingsBtn.textContent?.toLowerCase().includes('video')) return true; // Ya está en modo video

  await nativeClick(settingsBtn);
  await sleep(600);

  // En el popup que se abre, buscar la pestaña/botón que dice "Video" exactamente
  const videoTab = findButtonByTextSubstring('Video', true);
  if (videoTab) {
    await nativeClick(videoTab);
    await sleep(600);
    // Click fuera para cerrar el menú si se queda abierto
    document.body.click();
    return true;
  }

  return false;
}

function getComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slate-editor="true"]');
}

function getVisibleArrowButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter(
    (b) => b.querySelector('i')?.textContent === 'arrow_forward' && b.offsetParent !== null
  ) as HTMLButtonElement[];
}

// Clicks the submit button, handling both the collapsed (1 button) and
// expanded (2+ buttons) states of the Google Flow composer.
async function submitPrompt(composer: HTMLElement): Promise<boolean> {
  let arrowBtns = getVisibleArrowButtons();
  if (arrowBtns.length === 0) return false;

  if (arrowBtns.length === 1) {
    // Collapsed state — simulate Enter to trigger expansion, then native-click
    // the button in the expanded state.
    const firstBtn = arrowBtns[0];
    const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    composer.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
    composer.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
    await sleep(500);

    await nativeClick(firstBtn);
    await sleep(2500);

    const currentBtns = getVisibleArrowButtons();
    if (currentBtns.length === 0) return false;
    await nativeClick(currentBtns[currentBtns.length - 1]);
    return true;
  }

  // Expanded state — native-click the last (submit) button directly.
  await nativeClick(arrowBtns[arrowBtns.length - 1]);
  return true;
}

// ── Image polling ─────────────────────────────────────────────────────────────

// Takes a snapshot of all current image/video srcs so we can identify new ones
// after generation completes.
function getMediaSnapshot(): Set<string> {
  return new Set(
    Array.from(document.querySelectorAll('img, video'))
      .map((el) => {
        if (el.tagName === 'VIDEO')
          return (el as HTMLVideoElement).currentSrc || (el as HTMLVideoElement).src;
        return (el as HTMLImageElement).src;
      })
      .filter(Boolean)
  );
}

// Converts a blob: URL to a data URL so the extension popup can fetch it
// cross-origin (blob URLs are bound to the originating context).
async function blobUrlToDataUrl(blobUrl: string): Promise<string> {
  const res = await fetch(blobUrl);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

type MediaPollResult =
  | { status: 'success'; url: string }
  | { status: 'timeout' }
  | { status: 'aborted' }
  | { status: 'crashed' };

async function waitForNewMedia(
  beforeSnapshot: Set<string>,
  isVideo: boolean = false
): Promise<MediaPollResult> {
  // Para video damos hasta 6 minutos (240 intentos * 1.5s = 360s)
  const maxAttempts = isVideo ? 240 : MEDIA_POLL_MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (aborted) return { status: 'aborted' };

    // Si el editor desapareció del DOM, la página crasheó o recargó (pantalla negra)
    if (!getComposer()) return { status: 'crashed' };

    const currentMedia = Array.from(document.querySelectorAll('img, video'));
    const newMedia = currentMedia.filter((media) => {
      if (isVideo && media.tagName !== 'VIDEO') return false;
      if (!isVideo && media.tagName !== 'IMG') return false;

      const src =
        media.tagName === 'VIDEO'
          ? (media as HTMLVideoElement).currentSrc || (media as HTMLVideoElement).src
          : (media as HTMLImageElement).src;
      if (!src || beforeSnapshot.has(src)) return false;

      if (media.tagName === 'VIDEO') return true;
      // Para imágenes, solo consideramos las que parecen contenido generado.
      return (
        src.startsWith('blob:') ||
        (media as HTMLImageElement).naturalWidth > 150 ||
        (media as HTMLImageElement).width > 150
      );
    });

    if (newMedia.length > 0) {
      await sleepAbortable(MEDIA_STABILIZE_MS);
      if (aborted) return { status: 'aborted' };
      const finalSrc =
        newMedia[0].tagName === 'VIDEO'
          ? (newMedia[0] as HTMLVideoElement).currentSrc || (newMedia[0] as HTMLVideoElement).src
          : (newMedia[0] as HTMLImageElement).src;
      return { status: 'success', url: finalSrc };
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }
  return { status: 'timeout' };
}

// ── Image handler ─────────────────────────────────────────────────────────────

async function handleImageMode(
  prompt: string,
  sceneNumber: number | undefined,
  sendResponse: (r: ContentResponse) => void
) {
  log({ sceneNumber, step: 'Generando imagen en Google Flow', kind: LogKinds.Info });

  const composer = getComposer();
  if (!composer) {
    sendResponse({ success: false, error: 'Editor de Google Flow no encontrado.' });
    return;
  }

  const filled = await fillSlateComposer(composer, prompt);
  if (!filled) {
    sendResponse({ success: false, error: 'No se pudo escribir el prompt en Google Flow.' });
    return;
  }

  const submitted = await submitPrompt(composer);
  if (!submitted) {
    sendResponse({ success: false, error: 'No se pudo hacer clic en el botón de enviar.' });
    return;
  }

  sendResponse({ success: true, message: 'Enviado. Esperando imagen en Google Flow...' });

  if (sceneNumber === undefined) return;

  const beforeSnapshot = getMediaSnapshot();

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    if (aborted) return;

    log({
      sceneNumber,
      step: 'Esperando imagen',
      kind: LogKinds.Info,
      attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
      cooldownMs: MEDIA_POLL_MAX_ATTEMPTS * MEDIA_POLL_INTERVAL_MS,
    });

    const result = await waitForNewMedia(beforeSnapshot);

    if (result.status === 'aborted') return;
    if (result.status === 'crashed') {
      log({
        sceneNumber,
        step: 'La página de Google Flow crasheó, saltando escena',
        kind: LogKinds.Error,
      });
      await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
      return;
    }

    if (result.status === 'timeout') {
      if (attempt >= MAX_GENERATION_ATTEMPTS) {
        log({ sceneNumber, step: 'Tiempo agotado, saltando escena', kind: LogKinds.Error });
        await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
        return;
      }
      log({
        sceneNumber,
        step: 'Tiempo agotado, reintentando',
        kind: LogKinds.Retry,
        attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
        cooldownMs: GENERATION_RETRY_DELAY_MS,
      });
      await sleepAbortable(GENERATION_RETRY_DELAY_MS);
      if (aborted) return;

      const refilled = await fillSlateComposer(composer, prompt);
      const resubmitted = refilled && (await submitPrompt(composer));
      if (!resubmitted) {
        log({ sceneNumber, step: 'No se pudo reintentar, saltando escena', kind: LogKinds.Error });
        await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
        return;
      }
      continue;
    }

    // success
    log({ sceneNumber, step: 'Imagen lista, descargando', kind: LogKinds.Success });

    let finalUrl = result.url;
    if (finalUrl.startsWith('blob:')) {
      try {
        finalUrl = await blobUrlToDataUrl(finalUrl);
      } catch {
        // Keep the blob URL as fallback; the popup's fetchBlobWithRetry may handle it.
      }
    }

    await browser.runtime.sendMessage({
      action: Actions.DownloadMediaDirect,
      urls: [finalUrl],
      sceneNumber,
    });
    return;
  }
}

// ── Video handler ─────────────────────────────────────────────────────────────

async function handleVideoMode(
  prompt: string,
  imageBase64: string | null,
  imageName: string | null,
  sceneNumber: number | undefined,
  sendResponse: (r: ContentResponse) => void
) {
  log({ sceneNumber, step: 'Preparando video en Google Flow', kind: LogKinds.Info });

  const composer = getComposer();
  if (!composer) {
    sendResponse({ success: false, error: 'Editor de Google Flow no encontrado.' });
    return;
  }

  // 1. Cambiar la UI a modo Video
  const isVideoMode = await switchToVideoMode();
  if (!isVideoMode) {
    // Si falla el cambio de modo, lo reportamos, pero podríamos intentar continuar si asumimos
    // que arrastrar la imagen fuerza el modo (a veces pasa en UI modernas).
    log({
      sceneNumber,
      step: 'No se encontró el botón de Video, intentando forzar drop',
      kind: LogKinds.Info,
    });
  }

  // 2. Preparar el archivo a partir del base64
  if (!imageBase64 || !imageName) {
    sendResponse({ success: false, error: 'Imagen de referencia requerida para video.' });
    return;
  }
  const file = await base64ToFile(imageBase64, imageName);

  // 3. Inyectar prompt + archivo
  const filled = await fillSlateComposer(composer, prompt, file);
  if (!filled) {
    sendResponse({ success: false, error: 'No se pudo inyectar la imagen/texto en Google Flow.' });
    return;
  }

  // 4. Enviar
  const submitted = await submitPrompt(composer);
  if (!submitted) {
    sendResponse({ success: false, error: 'No se pudo hacer clic en el botón de enviar.' });
    return;
  }

  sendResponse({ success: true, message: 'Enviado. Esperando video en Google Flow...' });

  if (sceneNumber === undefined) return;

  const beforeSnapshot = getMediaSnapshot();

  // 5. Esperar resultado
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    if (aborted) return;

    log({
      sceneNumber,
      step: 'Esperando video (puede tardar varios minutos)',
      kind: LogKinds.Info,
      attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
      cooldownMs: 240 * MEDIA_POLL_INTERVAL_MS,
    });

    const result = await waitForNewMedia(beforeSnapshot, true);

    if (result.status === 'aborted') return;
    if (result.status === 'crashed') {
      log({
        sceneNumber,
        step: 'La página de Google Flow crasheó, saltando escena',
        kind: LogKinds.Error,
      });
      await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
      return;
    }

    if (result.status === 'timeout') {
      if (attempt >= MAX_GENERATION_ATTEMPTS) {
        log({ sceneNumber, step: 'Tiempo agotado, saltando escena', kind: LogKinds.Error });
        await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
        return;
      }
      log({
        sceneNumber,
        step: 'Tiempo agotado, reintentando',
        kind: LogKinds.Retry,
        attempt: { current: attempt, max: MAX_GENERATION_ATTEMPTS },
        cooldownMs: GENERATION_RETRY_DELAY_MS,
      });
      await sleepAbortable(GENERATION_RETRY_DELAY_MS);
      if (aborted) return;

      const refilled = await fillSlateComposer(composer, prompt, file);
      const resubmitted = refilled && (await submitPrompt(composer));
      if (!resubmitted) {
        log({ sceneNumber, step: 'No se pudo reintentar, saltando escena', kind: LogKinds.Error });
        await browser.runtime.sendMessage({ action: Actions.SceneFailed, sceneNumber });
        return;
      }
      continue;
    }

    // success
    log({ sceneNumber, step: 'Video listo, descargando', kind: LogKinds.Success });

    let finalUrl = result.url;
    if (finalUrl.startsWith('blob:')) {
      try {
        finalUrl = await blobUrlToDataUrl(finalUrl);
      } catch {
        // Fallback
      }
    }

    await browser.runtime.sendMessage({
      action: Actions.DownloadMediaDirect,
      urls: [finalUrl],
      sceneNumber,
    });
    return;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default defineContentScript({
  matches: ['*://labs.google/*'],
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
