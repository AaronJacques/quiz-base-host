import type { Config } from '../config.ts';
import type { BrowserDriver, ResponseWatch } from './driver.ts';
import { OrcaDriver } from './orca-driver.ts';
import { CdpDriver, PlaywrightDriver } from './playwright-driver.ts';
import type { LockOwner } from './profile-lock.ts';

export type { BrowserDriver, ResponseWatch } from './driver.ts';
export { ProfileBusyError, type LockOwner } from './profile-lock.ts';

/** Extras for the own Chromium (profile lock, passive observation). Orca and CDP ignore them. */
export interface DriverExtras {
  owner?: LockOwner;
  preemptible?: boolean;
  onPreempt?: () => void;
  lockWaitMs?: number;
  watch?: ResponseWatch;
}

export function createDriver(config: Config, extra: DriverExtras = {}): BrowserDriver {
  const b = config.browser;
  switch (b.driver) {
    case 'orca':
      return new OrcaDriver({ bin: b.orcaBin, pageId: b.orcaPageId });
    case 'cdp':
      return new CdpDriver({ cdpUrl: b.cdpUrl, baseUrl: config.baseUrl });
    case 'playwright':
    default:
      return new PlaywrightDriver({ profileDir: b.profileDir, headless: b.headless, ...extra });
  }
}
