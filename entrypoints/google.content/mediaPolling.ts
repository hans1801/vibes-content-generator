import { Actions } from '../../lib/types';
import {
  MEDIA_POLL_MAX_ATTEMPTS,
  MAX_MEDIA_PER_BATCH,
  MEDIA_STABILIZE_MS,
  MEDIA_POLL_INTERVAL_MS,
} from './constants';
import { aborted } from './abortState';
import { sleep } from './domUtils';
import { getComposer } from './composer';

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

// ── Image polling ─────────────────────────────────────────────────────────────

// Cada tile generado (imagen o video) queda envuelto en un elemento con
// data-tile-id="fe_id_<uuid>" — un identificador único y estable por resultado,
// a diferencia del src (que puede ser blob: mientras carga y luego cambiar a
// la URL final de /fx/api/trpc/media.getMediaUrlRedirect). El wrapper aparece
// duplicado en el DOM (contenedor externo + interno) con el mismo id, por eso
// deduplicamos.
interface MediaTile {
  id: string;
  isVideo: boolean;
  src: string;
}

function getMediaTiles(): MediaTile[] {
  const seen = new Set<string>();
  const tiles: MediaTile[] = [];

  document.querySelectorAll<HTMLElement>('[data-tile-id]').forEach((wrapper) => {
    const id = wrapper.getAttribute('data-tile-id');
    if (!id || seen.has(id)) return;

    const media = wrapper.querySelector<HTMLImageElement | HTMLVideoElement>('img, video');
    if (!media) return;

    const isVideo = media.tagName === 'VIDEO';
    const src = isVideo
      ? (media as HTMLVideoElement).currentSrc || (media as HTMLVideoElement).src
      : (media as HTMLImageElement).src;
    if (!src) return;

    seen.add(id);
    tiles.push({ id, isVideo, src });
  });

  return tiles;
}

// Snapshot de los tile-ids ya presentes antes de enviar el prompt, para poder
// distinguir después cuáles son resultados nuevos de esta generación.
export function getMediaTileIds(): Set<string> {
  return new Set(getMediaTiles().map((t) => t.id));
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

export const MediaPollStatuses = {
  Success: 'success',
  Timeout: 'timeout',
  Aborted: 'aborted',
  Crashed: 'crashed',
} as const;

export type MediaPollResult =
  | { status: typeof MediaPollStatuses.Success; urls: string[] }
  | { status: typeof MediaPollStatuses.Timeout }
  | { status: typeof MediaPollStatuses.Aborted }
  | { status: typeof MediaPollStatuses.Crashed };

// Espera a que aparezcan tiles nuevos y, una vez que aparece el primero, sigue
// esperando por si llegan más (Google Flow puede generar de 1 a 4 variantes
// por prompt, y a veces las entrega en tandas en vez de todas de golpe). El
// batch se da por completo cuando el conteo de tiles nuevos deja de crecer
// durante MEDIA_STABILIZE_MS, o cuando se alcanza el techo de
// MAX_MEDIA_PER_BATCH.
export async function waitForNewMedia(
  beforeIds: Set<string>,
  isVideo: boolean = false
): Promise<MediaPollResult> {
  // Para video damos hasta 6 minutos (240 intentos * 1.5s = 360s)
  const maxAttempts = isVideo ? 240 : MEDIA_POLL_MAX_ATTEMPTS;

  let lastCount = 0;
  let stableSince: number | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (aborted) return { status: MediaPollStatuses.Aborted };

    // Si el editor desapareció del DOM, la página crasheó o recargó (pantalla negra)
    if (!getComposer()) return { status: MediaPollStatuses.Crashed };

    const newTiles = getMediaTiles().filter((t) => t.isVideo === isVideo && !beforeIds.has(t.id));

    if (newTiles.length > 0) {
      if (newTiles.length !== lastCount) {
        // Llegó un tile nuevo (o varios): reinicia la ventana de estabilización.
        lastCount = newTiles.length;
        stableSince = Date.now();
      }

      const reachedMax = newTiles.length >= MAX_MEDIA_PER_BATCH;
      const isStable = stableSince !== null && Date.now() - stableSince >= MEDIA_STABILIZE_MS;

      if (reachedMax || isStable) {
        return { status: MediaPollStatuses.Success, urls: newTiles.map((t) => t.src) };
      }
    }

    await sleep(MEDIA_POLL_INTERVAL_MS);
  }
  return { status: MediaPollStatuses.Timeout };
}
