import { hasDep } from '../project.js';
import { htmlEntry } from './htmlEntry.js';
import type { Framework } from './types.js';

export const vueCli: Framework = {
  name: 'Vue CLI',
  matches: (project) => hasDep(project, '@vue/cli-service'),
  detect: (project) => htmlEntry(project, 'Vue CLI', ['public/index.html']),
};
