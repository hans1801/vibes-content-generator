// ── Network helpers ───────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 60000;
const FETCH_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBlobWithRetry(url: string): Promise<Blob | null> {
  // data: URLs don't need a network request — decode them directly.
  if (url.startsWith('data:')) {
    try {
      const res = await fetch(url);
      return await res.blob();
    } catch {
      return null;
    }
  }

  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      const resp = await fetchWithTimeout(url);
      if (resp.ok) return await resp.blob();
    } catch {
      /* network error or timeout — retry below */
    }
    if (attempt < FETCH_RETRIES - 1) await sleep(RETRY_BACKOFF_MS[attempt]);
  }
  return null;
}

// ── File system helpers ───────────────────────────────────────────────────────

export async function writeBlobToFile(dir: FileSystemDirectoryHandle, name: string, blob: Blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(blob);
  await writable.close();
}

// ── Watermark removal ─────────────────────────────────────────────────────────

// Vibes.ai stamps a "Meta AI" watermark in the bottom-right corner.
// Blurring that region makes it illegible without altering the image framing.
export async function blurWatermarkCorner(blob: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0);

    const regionW = Math.round(bitmap.width * 0.22);
    const regionH = Math.round(bitmap.height * 0.07);
    const x = bitmap.width - regionW;
    const y = bitmap.height - regionH;

    ctx.filter = 'blur(14px)';
    ctx.drawImage(canvas, x, y, regionW, regionH, x, y, regionW, regionH);
    ctx.filter = 'none';

    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  } catch {
    return blob;
  }
}
