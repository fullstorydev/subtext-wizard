import fs from 'node:fs';
import path from 'node:path';
import {
  type Project,
  depMajor,
  exists,
  firstExisting,
  hasDep,
  readRel,
  walkSource,
} from './project.js';

/** Where the snippet goes, and which editing strategy puts it there. */
export type Target =
  | { kind: 'html'; file: string }
  | { kind: 'astro'; file: string }
  | { kind: 'next-app'; file: string }
  | { kind: 'next-pages'; file: string; create: boolean }
  | { kind: 'jsx-head'; file: string }
  | { kind: 'nuxt-config'; file: string }
  | { kind: 'gatsby-ssr'; file: string };

export type Detection =
  | { ok: true; framework: string; target: Target }
  | { ok: false; reason: string; framework?: string };

const JS_EXTS = ['tsx', 'jsx', 'ts', 'js', 'mjs'];
const withExts = (base: string, exts = JS_EXTS) => exts.map((ext) => `${base}.${ext}`);

const fail = (reason: string, framework?: string): Detection => ({ ok: false, reason, framework });

export function detectTarget(project: Project): Detection {
  if (!project.hasPackageJson) return detectPlainHtml(project);

  if (isMonorepoRoot(project)) {
    return fail('this looks like a monorepo root; the snippet belongs in one of its apps');
  }

  // Native apps need the native SDK, not a <script> tag.
  if (hasDep(project, 'react-native', 'expo')) return fail('React Native needs the native SDK', 'React Native');

  if (hasDep(project, 'next')) return detectNext(project);
  if (hasDep(project, '@remix-run/react', '@remix-run/dev')) return detectRootRoute(project, 'Remix');
  if (hasDep(project, '@react-router/dev')) return detectRootRoute(project, 'React Router');
  if (hasDep(project, 'nuxt')) return detectNuxt(project);
  if (hasDep(project, '@sveltejs/kit')) return detectHtmlFile(project, 'SvelteKit', ['src/app.html']);
  if (hasDep(project, 'astro')) return detectAstro(project);
  if (hasDep(project, 'gatsby')) return detectGatsby(project);
  if (hasDep(project, '@angular/core')) return detectAngular(project);

  // Frameworks that render <head> in ways we don't edit statically.
  const unsupported: Array<[string, string[]]> = [
    ['TanStack Start', ['@tanstack/react-start', '@tanstack/start']],
    ['SolidStart', ['@solidjs/start']],
    ['Qwik City', ['@builder.io/qwik-city']],
    ['RedwoodJS', ['@redwoodjs/core']],
    ['Ember', ['ember-source']],
  ];
  for (const [name, packages] of unsupported) {
    if (hasDep(project, ...packages)) return fail(`${name} isn't covered by the automatic install`, name);
  }

  if (hasDep(project, 'react-scripts')) return detectHtmlFile(project, 'Create React App', ['public/index.html']);
  if (hasDep(project, '@vue/cli-service')) return detectHtmlFile(project, 'Vue CLI', ['public/index.html']);
  if (hasDep(project, 'vite')) return detectVite(project);

  return detectPlainHtml(project);
}

function isMonorepoRoot(project: Project): boolean {
  return (
    project.pkg.workspaces !== undefined ||
    ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json'].some((f) => exists(project, f))
  );
}

function detectNext(project: Project): Detection {
  const framework = 'Next.js';
  // Next ignores src/app when app/ exists, so check the root first.
  for (const base of ['', 'src/']) {
    const appDir = `${base}app`;
    const layout = firstExisting(project, withExts(`${appDir}/layout`, ['tsx', 'jsx', 'js']));
    if (layout) {
      // A root layout only covers App Router pages; any Pages Router pages
      // alongside it would go uncaptured.
      if (hasPagesRouterPages(project, `${base}pages`)) {
        return fail('the project mixes the App Router and Pages Router', framework);
      }
      return { ok: true, framework: `${framework} (App Router)`, target: { kind: 'next-app', file: layout } };
    }
    if (exists(project, appDir) && !exists(project, `${base}pages`)) {
      return fail('no root app/layout file (multiple root layouts?)', framework);
    }
  }
  for (const base of ['', 'src/']) {
    const pagesDir = `${base}pages`;
    if (!exists(project, pagesDir)) continue;
    const doc = firstExisting(project, withExts(`${pagesDir}/_document`, ['tsx', 'jsx', 'js', 'ts']));
    const target: Target = doc
      ? { kind: 'next-pages', file: doc, create: false }
      : {
          kind: 'next-pages',
          file: `${pagesDir}/_document.${project.typescript ? 'tsx' : 'js'}`,
          create: true,
        };
    return { ok: true, framework: `${framework} (Pages Router)`, target };
  }
  return fail('no app/ or pages/ directory found', framework);
}

function hasPagesRouterPages(project: Project, pagesDir: string): boolean {
  if (!exists(project, pagesDir)) return false;
  let found = false;
  walkSource(project, pagesDir, ['.tsx', '.jsx', '.js', '.ts', '.mdx'], (rel) => {
    // API routes don't render HTML, so an app/ project with pages/api is fine.
    const inner = path.relative(pagesDir, rel).split(path.sep);
    if (inner[0] !== 'api') found = true;
  });
  return found;
}

function detectRootRoute(project: Project, framework: string): Detection {
  // A custom appDirectory would move root.tsx; leave that to the agent.
  const configs = [...withExts('vite.config'), ...withExts('remix.config', ['js', 'mjs', 'cjs']), ...withExts('react-router.config')];
  for (const config of configs) {
    if (exists(project, config) && /appDirectory\s*:/.test(readRel(project, config))) {
      return fail(`${config} sets a custom appDirectory`, framework);
    }
  }
  const root = firstExisting(project, withExts('app/root', ['tsx', 'jsx', 'js']));
  if (!root) return fail('no app/root file found', framework);
  return { ok: true, framework, target: { kind: 'jsx-head', file: root } };
}

function detectNuxt(project: Project): Detection {
  const framework = 'Nuxt';
  const major = depMajor(project, 'nuxt');
  if (major !== undefined && major < 3) return fail('Nuxt 2 is not covered by the automatic install', framework);
  const config = firstExisting(project, withExts('nuxt.config', ['ts', 'js', 'mjs']));
  if (!config) return fail('no nuxt.config file found', framework);
  return { ok: true, framework, target: { kind: 'nuxt-config', file: config } };
}

function detectAstro(project: Project): Detection {
  const framework = 'Astro';
  const candidates: string[] = [];
  const complete = walkSource(project, 'src', ['.astro'], (rel, content) => {
    if (/<\/head>/i.test(content)) candidates.push(rel);
  });
  if (!complete) return fail('too many files to scan', framework);
  if (candidates.length === 0) return fail('no layout with a <head> found', framework);
  if (candidates.length > 1) {
    return fail(`${candidates.length} files render a <head> (${candidates.slice(0, 3).join(', ')})`, framework);
  }
  return { ok: true, framework, target: { kind: 'astro', file: candidates[0] } };
}

function detectGatsby(project: Project): Detection {
  const framework = 'Gatsby';
  const existing = firstExisting(project, withExts('gatsby-ssr', ['js', 'jsx', 'ts', 'tsx']));
  if (existing) return fail(`${existing} already exists and would need merging`, framework);
  return {
    ok: true,
    framework,
    target: { kind: 'gatsby-ssr', file: `gatsby-ssr.${project.typescript ? 'tsx' : 'js'}` },
  };
}

function detectAngular(project: Project): Detection {
  const framework = 'Angular';
  if (exists(project, 'angular.json')) {
    const config = JSON.parse(readRel(project, 'angular.json')) as {
      projects?: Record<string, { architect?: { build?: { options?: { index?: unknown } } } }>;
    };
    const indexes = Object.values(config.projects ?? {})
      .map((p) => p.architect?.build?.options?.index)
      .map((index) =>
        typeof index === 'string'
          ? index
          : typeof index === 'object' && index !== null && 'input' in index
            ? String((index as { input: unknown }).input)
            : undefined,
      )
      .filter((index): index is string => index !== undefined);
    if (new Set(indexes).size > 1) return fail('angular.json has several apps', framework);
    if (indexes.length === 1) return detectHtmlFile(project, framework, [indexes[0]]);
  }
  return detectHtmlFile(project, framework, ['src/index.html']);
}

function detectVite(project: Project): Detection {
  const framework = 'Vite';
  const config = firstExisting(project, [...withExts('vite.config'), 'vite.config.mts', 'vite.config.cjs']);
  if (config) {
    const text = readRel(project, config);
    // A custom root moves index.html; rollup `input` usually means a multi-page app.
    if (/\broot\s*:/.test(text)) return fail(`${config} sets a custom root`, framework);
    if (/\binput\s*:/.test(text)) return fail(`${config} configures multiple entry pages`, framework);
  }
  return detectHtmlFile(project, framework, ['index.html']);
}

function detectPlainHtml(project: Project): Detection {
  const candidates = ['index.html', 'public/index.html', 'src/index.html'].filter((f) => exists(project, f));
  if (candidates.length === 0) return fail("couldn't identify the framework or an index.html");
  if (candidates.length > 1) return fail(`several index.html candidates (${candidates.join(', ')})`);
  return detectHtmlFile(project, 'HTML', candidates);
}

function detectHtmlFile(project: Project, framework: string, candidates: string[]): Detection {
  const file = firstExisting(project, candidates);
  if (!file) return fail(`expected ${candidates.join(' or ')}`, framework);
  if (!fs.statSync(path.join(project.dir, file)).isFile()) return fail(`${file} is not a file`, framework);
  return { ok: true, framework, target: { kind: 'html', file } };
}
