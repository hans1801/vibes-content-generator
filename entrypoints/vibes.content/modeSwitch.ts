import { BatchModes, type BatchMode } from '../../lib/types';
import { ComposerSelectors } from '../../lib/selectors/vibes';
import { sleep, sleepAbortable, simulateClick, waitFor, waitForEnabledButton } from './domUtils';
import { aborted } from './abortState';

// ── Mode management ───────────────────────────────────────────────────────────

// Fixed SVG icon fingerprints for the Image/Video mode options — the same
// icon asset is reused verbatim on both the trigger (showing the active
// mode) and its matching item in the (untranslated) dropdown, so matching
// on the path data sidesteps the site's display language entirely. Image's
// icon is 2 paths; this is its short "dot" sub-path, an exact match. Video's
// is a single path; this prefix is already unique on the page.
const ModeIconPaths = {
  Image: 'M9.75 10.375a1.375 1.375 0 1 1 0 2.75 1.375 1.375 0 0 1 0-2.75z',
  Video: 'M8.42163',
} as const;

function hasModeIcon(el: HTMLElement, target: BatchMode): boolean {
  const prefix = target === BatchModes.Image ? ModeIconPaths.Image : ModeIconPaths.Video;
  return Array.from(el.querySelectorAll('svg path')).some((p) =>
    (p.getAttribute('d') ?? '').startsWith(prefix)
  );
}

// Which mode (if any) an element's icon shows.
function iconMode(el: HTMLElement): BatchMode | null {
  if (hasModeIcon(el, BatchModes.Image)) return BatchModes.Image;
  if (hasModeIcon(el, BatchModes.Video)) return BatchModes.Video;
  return null;
}

// The mode-toggle trigger is distinguished from identically-shaped buttons
// by having aria-haspopup="menu" as an ancestor and showing whichever mode
// icon (image or video) is currently active. The dropdown's own menuitems
// never match this: Radix portals the open menu to the end of <body>, not
// nested under the trigger, so closest() already excludes them.
function findModeTriggerButton(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => iconMode(btn) !== null && !!btn.closest('[aria-haspopup="menu"]')
    ) ?? null
  );
}

// Reads the trigger's own icon rather than the composer's translated
// aria-label — the trigger always shows whichever mode is currently active.
function getCurrentMode(): BatchMode | null {
  const trigger = findModeTriggerButton();
  return trigger ? iconMode(trigger) : null;
}

async function openModeMenu(): Promise<HTMLElement | null> {
  const trigger = findModeTriggerButton();
  if (!trigger) return null;
  await simulateClick(trigger);
  return waitFor(() => document.querySelector<HTMLElement>('[role="menu"][data-state="open"]'));
}

async function clickMenuItem(menu: HTMLElement, target: BatchMode): Promise<boolean> {
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
  const item = items.find((btn) => hasModeIcon(btn, target));
  if (!item) return false;
  await simulateClick(item);
  return true;
}

export async function ensureMode(target: BatchMode): Promise<boolean> {
  if (getCurrentMode() === target) return true;
  const menu = await openModeMenu();
  if (!menu) return false;
  if (!(await clickMenuItem(menu, target))) return false;
  const result = await waitFor(() => (getCurrentMode() === target ? true : null));
  return result === true;
}

// Waits for the composer node to be in the DOM — ensureMode already
// confirmed the mode switch itself, so this just covers the brief gap while
// Lexical mounts the node — then writes the prompt into it via execCommand,
// retrying up to 4 times for the same reason. Returns the filled composer
// (callers need it afterward, e.g. createGenerateAttempt's retries) or null
// if the node never showed up or never ended up holding the prompt.
export async function fillComposer(prompt: string, timeoutMs = 5000): Promise<HTMLElement | null> {
  const composer = await waitFor(
    () => document.querySelector<HTMLElement>(ComposerSelectors.Input),
    timeoutMs
  );
  if (!composer) return null;

  const expected = prompt.trim();
  for (let attempt = 0; attempt < 4; attempt++) {
    composer.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, prompt);
    await sleep(200);
    if (composer.textContent.trim() === expected) return composer;
  }
  return null;
}

// Builds one full "fill + click Generate" attempt, shared by handleImageMode
// and handleVideoMode: rewrites the prompt on every attempt (not just when
// it looks cleared — that check was unreliable and let clicks through on an
// empty/stale composer), then clicks once the button is enabled.
export function createGenerateAttempt(
  prompt: string,
  buttonSelector: string
): () => Promise<boolean> {
  return async () => {
    if (!(await fillComposer(prompt))) return false;
    await sleepAbortable(1300);
    if (aborted) return false;
    const btn = await waitForEnabledButton(buttonSelector);
    if (!btn || aborted) return false;
    await simulateClick(btn);
    return true;
  };
}
