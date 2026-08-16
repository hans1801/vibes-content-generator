export const MEDIA_POLL_INTERVAL_MS = 1500;
// Google Flow renders images faster than Vibes — a shorter stabilization
// window is sufficient.
export const MEDIA_STABILIZE_MS = 3000;
// ~2 minutes maximum wait for generation.
export const MEDIA_POLL_MAX_ATTEMPTS = 80;
export const MAX_GENERATION_ATTEMPTS = 4;
export const GENERATION_RETRY_DELAY_MS = 20000;
// Google Flow genera entre 1 y 4 variantes por prompt, y a veces llegan en
// tandas (de a 2) en vez de todas de golpe. No hay forma de saber de antemano
// cuántas serán, así que 4 es solo el techo para cortar la espera si ya se llenó.
export const MAX_MEDIA_PER_BATCH = 4;

// How long background.ts should wait before moving to the next scene after
// this one fails outright (not a within-generation retry — a full give-up).
// Video gets more breathing room for the same rate-limit reason noted above.
export const IMAGE_SCENE_RETRY_DELAY_MS = 4500;
export const VIDEO_SCENE_RETRY_DELAY_MS = 12000;
