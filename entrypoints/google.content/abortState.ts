// Set to true when the background relays a StopBatch to this tab. Every
// long-running wait checks it so a stop takes effect within a couple of seconds.
export let aborted = false;

// Only index.ts (the entry point, on StopBatch/SendPrompt) reassigns this —
// everyone else just reads the live `aborted` binding above.
export function setAborted(value: boolean) {
  aborted = value;
}
