import type { Config } from '../config.ts';
import type { BrowserDriver } from './driver.ts';
import { OrcaDriver } from './orca-driver.ts';
import { CdpDriver, PlaywrightDriver } from './playwright-driver.ts';

export type { BrowserDriver } from './driver.ts';

export function createDriver(config: Config): BrowserDriver {
  const b = config.browser;
  switch (b.driver) {
    case 'orca':
      return new OrcaDriver({ bin: b.orcaBin, pageId: b.orcaPageId });
    case 'cdp':
      return new CdpDriver({ cdpUrl: b.cdpUrl, baseUrl: config.baseUrl });
    case 'playwright':
    default:
      return new PlaywrightDriver({ profileDir: b.profileDir, headless: b.headless });
  }
}
