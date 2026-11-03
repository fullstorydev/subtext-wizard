import { INSTALL_PAGES } from './pages.generated.js';
import type { InstallStep } from './steps.js';

export { INSTALL_STEPS, type InstallStep } from './steps.js';

const ORG_ID = /^o-[A-Za-z0-9]+-(na1|eu1)$/;

/**
 * Install instructions for one step, with the org id filled in. The text comes
 * from the marketing site (synced into pages.generated.ts by CI), so headless
 * agents get the same instructions as GUI agents without needing network
 * access or fetch permissions of their own.
 */
export function getInstallPage(step: InstallStep, orgId: string): string {
  if (!ORG_ID.test(orgId)) throw new Error(`Not a valid org id: ${orgId}`);
  return INSTALL_PAGES[step].replaceAll('{{ORG_ID}}', orgId);
}
