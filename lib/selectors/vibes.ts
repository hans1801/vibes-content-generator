export const ComposerSelectors = {
  Input: '[data-lexical-editor="true"][contenteditable="true"]',
} as const;

export const GallerySelectors = {
  // Each generated thumbnail card; while media is still rendering the card
  // holds a <canvas> skeleton instead of the real <img>/<video>, so presence
  // of a loaded img[data-nimg="fill"] or video[src] is what marks it "ready".
  Thumbnail: '[data-analytics-id="creation_gallery.thumbnail_click"]',
} as const;

export const GenerateButtonSelectors = {
  Image: 'button[data-analytics-id="send_message"][data-analytics-prompt-type="images"]',
  Video: 'button[data-analytics-id="send_message"][data-analytics-prompt-type="videos"]',
} as const;

export const StartEndFrameSelectors = {
  Toggle: 'button[data-analytics-id="creation_gallery.start_end_frame_selection_click"]',
} as const;
