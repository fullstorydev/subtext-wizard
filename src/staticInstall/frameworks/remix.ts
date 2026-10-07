import { appendToJsxHead, jsxScript } from '../edit/js.js';
import { type Project, exists, firstExisting, hasDep, readRel } from '../project.js';
import { type Detection, type Framework, fail, withExts } from './types.js';

export const remix: Framework = {
  name: 'Remix',
  matches: (project) => hasDep(project, '@remix-run/react', '@remix-run/dev'),
  detect: (project) => detectRootRoute(project, 'Remix'),
};

/** Remix and React Router v7 framework mode share the app/root layout. */
export function detectRootRoute(project: Project, framework: string): Detection {
  // A custom appDirectory would move root.tsx; leave that to the agent.
  const configs = [
    ...withExts('vite.config'),
    ...withExts('remix.config', ['js', 'mjs', 'cjs']),
    ...withExts('react-router.config'),
  ];
  for (const config of configs) {
    if (exists(project, config) && /appDirectory\s*:/.test(readRel(project, config))) {
      return fail(`${config} sets a custom appDirectory`, framework);
    }
  }
  const root = firstExisting(project, withExts('app/root', ['tsx', 'jsx', 'js']));
  if (!root) return fail('no app/root file found', framework);
  return {
    ok: true,
    plan: { framework, file: root, edit: (original, { body }) => appendToJsxHead(original, 'head', jsxScript('script', body)) },
  };
}
