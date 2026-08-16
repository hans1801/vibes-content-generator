export const WAIT_TIMEOUT_MS = 8000;
export const UPLOAD_WAIT_TIMEOUT_MS = 120000;
export const WAIT_INTERVAL_MS = 200;
export const MEDIA_POLL_INTERVAL_MS = 2000;
// Safety net only — in practice all 4 slots for a batch render (as <canvas>
// placeholders) within a couple seconds of clicking Generate. This just
// guards against looping forever if the click silently didn't register.
export const BATCH_ID_CAPTURE_TIMEOUT_MS = 15000;
// Once a batch's id is known, how long to wait for its up to 4 slots to
// settle (each becomes 'ready' or 'failed') before deciding with whatever
// succeeded so far. Video takes longer than image, so it gets more room.
export const IMAGE_BATCH_SETTLE_TIMEOUT_MS = 45000;
export const VIDEO_BATCH_SETTLE_TIMEOUT_MS = 75000;
export const MAX_UPLOAD_ATTEMPTS = 5;
export const UPLOAD_RETRY_DELAY_MS = 12000;
// If clicking confirm doesn't close the upload dialog, the file itself is
// already staged — re-click confirm instead of re-selecting the file and
// burning a whole extra upload attempt.
export const MAX_CONFIRM_ATTEMPTS = 3;
export const CONFIRM_CLOSE_TIMEOUT_MS = 20000;
export const MAX_GENERATION_ATTEMPTS = 5;
export const GENERATION_RETRY_DELAY_MS = 10000;

// How long background.ts should wait before moving to the next scene after
// this one fails outright (not a within-generation retry — a full give-up).
// Video gets more breathing room for the same rate-limit reason as above.
export const IMAGE_SCENE_RETRY_DELAY_MS = 4500;
export const VIDEO_SCENE_RETRY_DELAY_MS = 12000;

// "Add start frame"/"Add end frame" share this icon's badge sub-path —
// language-independent fingerprint. Start vs end is just enabled-state.
export const ADD_FRAME_ICON_PATH = 'M25 17a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 2.875a.625';
// Cloud-upload icon on the picker dialog's "Upload" nav tab — unique within
// its scope (a copy exists elsewhere on the page, outside that scope).
export const UPLOAD_ICON_PATH = 'M6.125 17.2c0 .826';
// Blue border class a picker tile gains once clicked — selected-state marker.
export const SELECTED_TILE_MARKER = 'bd-c_var(--blue-500)';
// "Add to video" confirm button — unique within the picker dialog's scope
// by this accent color (the upload sub-dialog reuses it but is closed by then).
export const ADD_TO_VIDEO_BUTTON_CLASS = 'bg_var(--fill-blue)';
// The small "×" overlay on the start-frame thumbnail. Its icon is a generic
// close glyph reused elsewhere (e.g. dialog close buttons), so size
// disambiguates: this one is 16x16, dialog closes are 32x32. This app never
// manages an "end frame", so it's the only such small remove button around.
export const CLOSE_ICON_PATH = 'M22.88 24.12a.877.877 0 0 0 1.239-1.239';
export const REMOVE_FRAME_BUTTON_SIZE_CLASS = 'h_16px w_16px';
// A finished video's src is always a final fbcdn.net CDN URL ending in
// .mp4, never a placeholder — the subdomain varies (video-*, scontent-*,
// ...), so only the host suffix + extension are reliable. Matching this is
// extra confirmation the file is actually there, on top of the <video>'s
// own readyState.
export const READY_VIDEO_URL_PATTERN = /^https:\/\/[\w.-]+\.fbcdn\.net\/.*\.mp4/;
