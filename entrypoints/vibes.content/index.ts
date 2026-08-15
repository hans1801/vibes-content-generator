import { Actions, BatchModes } from '../../lib/types';
import type { ExtensionMessage, ContentResponse } from '../../lib/types';
import { setAborted } from './abortState';
import { handleImageMode, handleVideoMode } from './modeHandlers';

export default defineContentScript({
  matches: ['*://*.vibes.ai/*', '*://vibes.ai/*'],
  main() {
    browser.runtime.onMessage.addListener(
      (message: ExtensionMessage, _sender, sendResponse: (r: ContentResponse) => void) => {
        // Only 2 actions matter to this content script — everything else
        // (NativeClick, GetBatchStatus, etc.) is background.ts's business.
        switch (message.action) {
          case Actions.StopBatch:
            setAborted(true);
            return false;

          case Actions.FillPrompt: {
            setAborted(false);
            const { prompt, mediaType, imageBase64, imageName, sceneNumber } = message;
            if (mediaType === BatchModes.Image) {
              handleImageMode(prompt, sceneNumber, sendResponse);
            } else {
              handleVideoMode(prompt, imageBase64, imageName, sceneNumber, sendResponse);
            }
            return true;
          }

          default:
            return false;
        }
      }
    );
  },
});
