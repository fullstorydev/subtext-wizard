import { type Project, exists } from '../project.js';
import { angular } from './angular.js';
import { astro } from './astro.js';
import { createReactApp } from './createReactApp.js';
import { gatsby } from './gatsby.js';
import { next } from './next.js';
import { nuxt } from './nuxt.js';
import { plainHtml } from './plainHtml.js';
import { reactRouter } from './reactRouter.js';
import { remix } from './remix.js';
import { sveltekit } from './sveltekit.js';
import { type Detection, fail } from './types.js';
import { reactNative, unsupportedFrameworks } from './unsupported.js';
import { vite } from './vite.js';
import { vueCli } from './vueCli.js';

export type { Detection, Framework, Plan, Snippet } from './types.js';

// First match wins. Meta-frameworks come before vite, which most of them
// depend on, and React Native before everything since it can sit next to web deps.
const FRAMEWORKS = [
  reactNative,
  next,
  remix,
  reactRouter,
  nuxt,
  sveltekit,
  astro,
  gatsby,
  angular,
  ...unsupportedFrameworks,
  createReactApp,
  vueCli,
  vite,
];

export function detectFramework(project: Project): Detection {
  if (!project.hasPackageJson) return plainHtml.detect(project);
  if (isMonorepoRoot(project)) {
    return fail('this looks like a monorepo root; the snippet belongs in one of its apps');
  }
  return (FRAMEWORKS.find((f) => f.matches(project)) ?? plainHtml).detect(project);
}

function isMonorepoRoot(project: Project): boolean {
  return (
    project.pkg.workspaces !== undefined ||
    ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json'].some((f) => exists(project, f))
  );
}
