import { sleep, nativeClick, nativeType } from './domUtils';

export function getComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slate-editor="true"]');
}

// Google Flow uses Slate.js which validates the origin of input events. The
// only reliable way to insert text and files is via a DataTransfer drop event at the
// center coordinates of the editor node.
export async function fillSlateComposer(
  composer: HTMLElement,
  prompt: string,
  file?: File
): Promise<boolean> {
  const expected = prompt.trim();

  for (let attempt = 0; attempt < 4; attempt++) {
    composer.focus();

    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    await sleep(100);

    const rect = composer.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    // 1. Inyectar la imagen primero (si existe)
    if (file) {
      const fileDt = new DataTransfer();
      fileDt.items.add(file);
      // Engañar a React Dropzone para que crea que hay archivos arrastrados
      Object.defineProperty(fileDt, 'types', { value: ['Files'], configurable: true });

      // Disparar en el padre (muchas veces el dropzone envuelve al editor entero)
      const dropTarget = composer.parentElement || composer;
      dropTarget.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: fileDt,
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        })
      );

      // Fallback con paste en el editor
      composer.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: fileDt, bubbles: true, cancelable: true })
      );

      // Esperar activamente a que la UI procese la imagen (hasta 20 segundos)
      let imageAppeared = false;
      const container = composer.parentElement?.parentElement;
      for (let wait = 0; wait < 40; wait++) {
        await sleep(500);
        if (container?.querySelector('img')) {
          imageAppeared = true;
          break;
        }
      }

      if (!imageAppeared) {
        console.warn(
          `[OmniFlow] ⚠️ Intento ${attempt + 1}: La imagen no apareció en el chat a tiempo. Reintentando...`
        );
        continue; // Volver a intentar todo el ciclo
      }
    }

    // 2. Inyectar el texto usando el Debugger nativo de Chrome
    // Como vimos, Slate bloquea los eventos artificiales (isTrusted: false).
    // Usaremos el mismo truco que usamos para hacer clics (NativeClick), pero para escribir.
    composer.focus();
    await sleep(200);
    await nativeType(prompt);
    await sleep(400);

    // Mantenemos esto por seguridad, pero nativeType ya hace el trabajo
    composer.dispatchEvent(new Event('input', { bubbles: true }));

    await sleep(400);

    if (file) {
      console.log(`[OmniFlow] ✅ Intento yuu ${attempt + 1}: Texto inyectado e imagen confirmada.`);
      return true;
    } else {
      if (composer.textContent.trim().includes(expected)) {
        return true;
      }
    }
  }

  console.error(
    '[OmniFlow] ❌ Fallo crítico: Se agotaron los intentos y la imagen/texto no se adjuntó. Abortando.'
  );
  return false;
}

function getVisibleArrowButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter(
    (b) => b.querySelector('i')?.textContent === 'arrow_forward' && b.offsetParent !== null
  ) as HTMLButtonElement[];
}

// Clicks the submit button, handling both the collapsed (1 button) and
// expanded (2+ buttons) states of the Google Flow composer.
export async function submitPrompt(composer: HTMLElement): Promise<boolean> {
  const arrowBtns = getVisibleArrowButtons();
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
