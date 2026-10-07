import { hasDep } from '../project.js';
import { detectRootRoute } from './remix.js';
import type { Framework } from './types.js';

/** React Router v7 in framework mode (the Remix successor). */
export const reactRouter: Framework = {
  name: 'React Router',
  matches: (project) => hasDep(project, '@react-router/dev'),
  detect: (project) => detectRootRoute(project, 'React Router'),
};
