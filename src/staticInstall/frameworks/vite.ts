import { firstExisting, hasDep, readRel } from '../project.js';
import { htmlEntry } from './htmlEntry.js';
import { type Framework, fail, withExts } from './types.js';

const NAME = 'Vite';

/** Plain Vite apps (React, Vue, Svelte, Solid, Preact…). Meta-frameworks built on Vite match earlier. */
export const vite: Framework = {
  name: NAME,
  matches: (project) => hasDep(project, 'vite'),
  detect(project) {
    const config = firstExisting(project, [...withExts('vite.config'), 'vite.config.mts', 'vite.config.cjs']);
    if (config) {
      const text = readRel(project, config);
      // A custom root moves index.html; rollup `input` usually means a multi-page app.
      if (/\broot\s*:/.test(text)) return fail(`${config} sets a custom root`, NAME);
      if (/\binput\s*:/.test(text)) return fail(`${config} configures multiple entry pages`, NAME);
    }
    return htmlEntry(project, NAME, ['index.html']);
  },
};
