import { hasDep } from '../project.js';
import { htmlEntry } from './htmlEntry.js';
import type { Framework } from './types.js';

export const sveltekit: Framework = {
  name: 'SvelteKit',
  matches: (project) => hasDep(project, '@sveltejs/kit'),
  detect: (project) => htmlEntry(project, 'SvelteKit', ['src/app.html']),
};
