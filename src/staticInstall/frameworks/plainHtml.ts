import { exists } from '../project.js';
import { htmlEntry } from './htmlEntry.js';
import { type Framework, fail } from './types.js';

/** The fallback when no framework matched: a static site with one index.html. */
export const plainHtml: Framework = {
  name: 'HTML',
  matches: () => true,
  detect(project) {
    const candidates = ['index.html', 'public/index.html', 'src/index.html'].filter((f) => exists(project, f));
    if (candidates.length === 0) return fail("couldn't identify the framework or an index.html");
    if (candidates.length > 1) return fail(`several index.html candidates (${candidates.join(', ')})`);
    return htmlEntry(project, 'HTML', candidates);
  },
};
