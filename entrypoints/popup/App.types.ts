import type { LogUpdate } from '../../lib/types';

export const AppModes = {
  HowToUse: 'how-to-use',
  Project: 'project',
} as const;

export type AppMode = (typeof AppModes)[keyof typeof AppModes];

// LogUpdate as actually displayed, plus a local receivedAt timestamp for
// the cooldown countdown.
export type LogStatus = LogUpdate & { receivedAt: number };
