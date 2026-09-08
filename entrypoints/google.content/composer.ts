import { sleep, nativeClick, nativeType } from './domUtils';

export function getComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.ProseMirror');
}

// Google Flow blocks synthetic (isTrusted: false) input events — text must
// go in via the native Chrome Debugger typing trick (nativeType), same as
// clicks use nativeClick.
export async function fillSlateComposer(composer: HTMLElement, prompt: string): Promise<boolean> {
  const expected = prompt.trim();

  for (let attempt = 0; attempt < 4; attempt++) {
    composer.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    await sleep(100);

    composer.focus();
    await sleep(200);
    await nativeType(prompt);
    await sleep(400);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);

    if (composer.textContent.trim().includes(expected)) return true;
  }

  return false;
}

function getVisibleArrowButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter(
    (b) =>
      b.querySelector('mat-icon')?.textContent?.trim() === 'arrow_forward' &&
      b.offsetParent !== null
  ) as HTMLButtonElement[];
}

export async function submitPrompt(composer: HTMLElement): Promise<boolean> {
  const arrowBtns = getVisibleArrowButtons();
  if (arrowBtns.length === 0) return false;

  await nativeClick(arrowBtns[arrowBtns.length - 1]);
  return true;
}
