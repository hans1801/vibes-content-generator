import { sleep, nativeClick, findButtonByTextSubstring } from './domUtils';

// Intenta cambiar la interfaz de Google Flow a modo "Video" si está en "Image"
export async function switchToVideoMode(): Promise<boolean> {
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
