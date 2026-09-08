// Simulates real OS-level mouse/keyboard input via the Chrome DevTools
// Protocol debugger — some sites' React handlers ignore synthetic DOM events
// (element.click(), KeyboardEvent) but do respond to actual input dispatched
// this way.

export async function nativeClick(tabId: number, x: number, y: number) {
  try {
    await browser.debugger.attach({ tabId }, '1.3');
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await browser.debugger.detach({ tabId });
  } catch {
    // Debugger attach can fail if the tab is already attached; silently ignore.
  }
}

// Angular only listens for a trusted mouseenter — a gallery tile's real
// <video> doesn't mount until actually hovered (confirmed: unhovered it's
// just an <img class="thumbnail">).
export async function nativeHover(tabId: number, x: number, y: number) {
  try {
    await browser.debugger.attach({ tabId }, '1.3');
    await browser.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await browser.debugger.detach({ tabId });
  } catch {
    // Debugger attach can fail if the tab is already attached; silently ignore.
  }
}

export async function nativeType(tabId: number, text: string) {
  try {
    await browser.debugger.attach({ tabId }, '1.3');
    await browser.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
    await browser.debugger.detach({ tabId });
  } catch {
    // Silently ignore
  }
}
