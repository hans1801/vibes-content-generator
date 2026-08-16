import { WAIT_TIMEOUT_MS, WAIT_INTERVAL_MS } from './constants';
import { aborted } from './abortState';

export function waitFor<T>(
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

export function waitForEnabledButton(
  selector: string,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<HTMLButtonElement | null> {
  return waitFor(() => {
    const btn = document.querySelector<HTMLButtonElement>(selector);
    return btn && !btn.disabled ? btn : null;
  }, timeoutMs);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sleepAbortable(ms: number) {
  const step = 500;
  let waited = 0;
  while (waited < ms && !aborted) {
    await sleep(Math.min(step, ms - waited));
    waited += step;
  }
}

// Dispatches the full pointer + mouse event sequence required to trigger
// Radix UI components (which open on `pointerdown`, not `click`) and
// Framer Motion press handlers (which validate coordinates against element
// bounds). Coordinates are centered on the real element to pass hit-tests.
// A random 1–2 s pause after each click prevents vibes.ai rate-limiting.
export async function simulateClick(el: HTMLElement) {
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

export function dataURLtoFile(dataurl: string, filename: string): File {
  const arr = dataurl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new File([u8arr], filename, { type: mime });
}
