import { hasDep } from '../project.js';
import { htmlEntry } from './htmlEntry.js';
import type { Framework } from './types.js';

export const createReactApp: Framework = {
  name: 'Create React App',
  matches: (project) => hasDep(project, 'react-scripts'),
  detect: (project) => htmlEntry(project, 'Create React App', ['public/index.html']),
};
