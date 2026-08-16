import { Actions } from '../../lib/types';
import type { LogUpdate } from '../../lib/types';

export function log(update: LogUpdate) {
  browser.runtime.sendMessage({ action: Actions.Log, ...update }).catch(() => {});
}
