import { describe, expect, it } from 'vitest';
import { INSTALL_PAGES } from './pages.generated.js';
import { INSTALL_STEPS, getInstallPage } from './index.js';

describe('install pages snapshot', () => {
  it.each(INSTALL_STEPS)('%s has no leftover placeholders or page navigation', (step) => {
    const page = INSTALL_PAGES[step];
    expect(page.match(/\{\{(?!ORG_ID\}\})[^}]*\}\}/g)).toBeNull();
    expect(page).not.toMatch(/^## Next/m);
  });

  it('fills the org id into the capture snippet', () => {
    const page = getInstallPage('capture', 'o-1A2B3C-na1');
    expect(page).toContain("window['_fs_org'] = 'o-1A2B3C-na1';");
    expect(page).not.toContain('{{ORG_ID}}');
  });

  it('rejects anything that is not an org id', () => {
    expect(() => getInstallPage('capture', "x'; alert(1); '")).toThrow(/valid org id/);
  });
});
