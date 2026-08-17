export const MEDIA_POLL_INTERVAL_MS = 1500;
// Google Flow renders images faster than Vibes — a shorter stabilization
// window is sufficient.
export const MEDIA_STABILIZE_MS = 3000;
// ~2 minutes maximum wait for generation.
export const IMAGE_MEDIA_POLL_MAX_ATTEMPTS = 80;
// Video takes longer — up to 6 minutes (240 * 1.5s).
export const VIDEO_MEDIA_POLL_MAX_ATTEMPTS = 240;
export const MAX_GENERATION_ATTEMPTS = 4;
// Google Flow genera entre 1 y 4 variantes por prompt, y a veces llegan en
// tandas (de a 2) en vez de todas de golpe. No hay forma de saber de antemano
// cuántas serán, así que 4 es solo el techo para cortar la espera si ya se llenó.
export const MAX_MEDIA_PER_BATCH = 4;

// How long background.ts should wait before moving to the next scene after
// this one fails outright (not a within-generation retry — a full give-up).
// Video gets more breathing room for the same rate-limit reason noted above.
export const IMAGE_SCENE_RETRY_DELAY_MS = 4500;
export const VIDEO_SCENE_RETRY_DELAY_MS = 12000;

// Start frame upload (video mode) — see startFrame.ts.
export const UPLOAD_WAIT_TIMEOUT_MS = 60000;
export const MAX_UPLOAD_ATTEMPTS = 5;
export const UPLOAD_RETRY_DELAY_MS = 12000;
// If confirm doesn't close the popover, the file is already staged —
// re-click confirm instead of re-uploading.
export const MAX_CONFIRM_ATTEMPTS = 3;
export const CONFIRM_CLOSE_TIMEOUT_MS = 20000;
