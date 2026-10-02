import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { afterEach, describe, expect, it } from 'vitest';
import { applyStaticEdit, planStaticInstall, type StaticEdit, type StaticPlan } from './index.js';

const SNIPPET = `<script>
window['_fs_host'] = 'fullstory.com';
window['_fs_script'] = 'edge.fullstory.com/s/fs.js';
window['_fs_org'] = 'o-TEST-na1';
!function(m,n){var a="x";m.q=[]}(window,document);
</script>`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway project from a { relPath: content } map; objects become JSON. */
function project(files: Record<string, string | object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtext-static-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const pkg = (deps: Record<string, string>, extra: object = {}) => ({ name: 'app', dependencies: deps, ...extra });

function expectEdit(plan: StaticPlan): StaticEdit {
  if (plan.kind !== 'edit') throw new Error(`expected an edit, got ${JSON.stringify(plan)}`);
  return plan.edit;
}

function expectFallback(plan: StaticPlan, reason: RegExp) {
  expect(plan.kind).toBe('fallback');
  if (plan.kind === 'fallback') expect(plan.reason).toMatch(reason);
}

const parsesAsTsx = (code: string) =>
  expect(() => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();

const VITE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Vite App</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

describe('HTML entry points', () => {
  it('inserts before </head> in a Vite index.html, matching indentation', () => {
    const dir = project({ 'package.json': pkg({ react: '^18', vite: '^5' }), 'index.html': VITE_HTML });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));

    expect(edit.framework).toBe('Vite');
    expect(edit.file).toBe('index.html');
    expect(edit.content).toContain(`    <title>Vite App</title>\n    <script>\n    window['_fs_host']`);
    expect(edit.content).toContain(`    </script>\n  </head>`);
    expect(edit.content.match(/<script>/g)).toHaveLength(1);
  });

  it.each([
    ['Create React App', { 'react-scripts': '5' }, 'public/index.html'],
    ['Vue CLI', { '@vue/cli-service': '5' }, 'public/index.html'],
    ['SvelteKit', { '@sveltejs/kit': '2' }, 'src/app.html'],
    ['Angular', { '@angular/core': '17' }, 'src/index.html'],
  ])('targets the %s entry file', (framework, deps, file) => {
    const dir = project({ 'package.json': pkg(deps), [file]: VITE_HTML });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    expect(edit.framework).toBe(framework);
    expect(edit.file).toBe(file);
  });

  it('uses the index from angular.json when it is not the default', () => {
    const dir = project({
      'package.json': pkg({ '@angular/core': '17' }),
      'angular.json': { projects: { web: { architect: { build: { options: { index: 'web/index.html' } } } } } },
      'web/index.html': VITE_HTML,
    });
    expect(expectEdit(planStaticInstall(dir, SNIPPET)).file).toBe('web/index.html');
  });

  it('handles a plain static site with no package.json', () => {
    const dir = project({ 'index.html': '<html><head><title>x</title></head><body></body></html>' });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    expect(edit.framework).toBe('HTML');
    expect(edit.content).toMatch(/<title>x<\/title>\n {2}<script>[\s\S]*<\/script>\n<\/head>/);
  });

  it('marks Astro scripts is:inline so they are not bundled', () => {
    const dir = project({
      'package.json': pkg({ astro: '4' }),
      'src/layouts/Layout.astro': `---\nconst { title } = Astro.props;\n---\n<html>\n  <head>\n    <title>{title}</title>\n  </head>\n  <body><slot /></body>\n</html>\n`,
      'src/pages/index.astro': `---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout title="Home" />\n`,
    });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    expect(edit.file).toBe(path.join('src', 'layouts', 'Layout.astro'));
    expect(edit.content).toContain('<script is:inline>');
  });
});

const NEXT_LAYOUT = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "App" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
`;

describe('Next.js', () => {
  it('adds a beforeInteractive Script to the App Router root layout', () => {
    const dir = project({ 'package.json': pkg({ next: '15', react: '19' }), 'app/layout.tsx': NEXT_LAYOUT, 'tsconfig.json': '{}' });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));

    expect(edit.framework).toBe('Next.js (App Router)');
    expect(edit.content).toContain(`import "./globals.css";\nimport Script from "next/script";\n`);
    expect(edit.content).toContain(
      `      <body className="antialiased">\n        <Script id="subtext-capture" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: "window['_fs_host']`,
    );
    parsesAsTsx(edit.content);
  });

  it('reuses an existing next/script import and prefers <head> when present', () => {
    const layout = `import Script from 'next/script'

export default function RootLayout({ children }) {
  return (
    <html>
      <head>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>{children}</body>
    </html>
  )
}
`;
    const dir = project({ 'package.json': pkg({ next: '14' }), 'src/app/layout.jsx': layout });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    expect(edit.file).toBe('src/app/layout.jsx');
    expect(edit.content.match(/from 'next\/script'/g)).toHaveLength(1);
    expect(edit.content).toMatch(/<link rel="icon" href="\/favicon.ico" \/>\n {8}<Script id="subtext-capture"[^\n]*\/>\n {6}<\/head>/);
    parsesAsTsx(edit.content);
  });

  it('falls back when the App Router and Pages Router are mixed', () => {
    const dir = project({
      'package.json': pkg({ next: '14' }),
      'app/layout.tsx': NEXT_LAYOUT,
      'pages/about.tsx': 'export default function About() { return null }',
    });
    expectFallback(planStaticInstall(dir, SNIPPET), /mixes the App Router and Pages Router/);
  });

  it('ignores pages/api next to the App Router', () => {
    const dir = project({
      'package.json': pkg({ next: '14' }),
      'app/layout.tsx': NEXT_LAYOUT,
      'pages/api/hello.ts': 'export default function handler() {}',
    });
    expect(planStaticInstall(dir, SNIPPET).kind).toBe('edit');
  });

  it('edits <Head> in an existing pages/_document', () => {
    const doc = `import Document, { Html, Head, Main, NextScript } from "next/document";

export default class MyDocument extends Document {
  render() {
    return (
      <Html>
        <Head />
        <body><Main /><NextScript /></body>
      </Html>
    );
  }
}
`;
    const dir = project({ 'package.json': pkg({ next: '13' }), 'pages/_document.tsx': doc, 'pages/index.tsx': '' });
    // <Head /> is self-closing: no children to append to, so the agent takes it.
    expectFallback(planStaticInstall(dir, SNIPPET), /safe insertion point in pages\/_document\.tsx/);

    fs.writeFileSync(path.join(dir, 'pages/_document.tsx'), doc.replace('<Head />', '<Head>\n          <meta name="x" />\n        </Head>'));
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    expect(edit.content).toMatch(/<meta name="x" \/>\n {10}<script id="subtext-capture"/);
    parsesAsTsx(edit.content);
  });

  it('creates pages/_document when there is none', () => {
    const dir = project({ 'package.json': pkg({ next: '13' }), 'pages/index.js': '', });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    expect(edit.file).toBe('pages/_document.js');
    expect(edit.original).toBeUndefined();
    parsesAsTsx(edit.content);

    expect(applyStaticEdit(dir, edit)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(dir, 'pages/_document.js'), 'utf8')).toBe(edit.content);
  });
});

describe('Remix / React Router', () => {
  const root = `import { Links, Meta, Outlet, Scripts } from "@remix-run/react";

export default function App() {
  return (
    <html lang="en">
      <head>
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
`;

  it.each([
    ['Remix', { '@remix-run/react': '2' }],
    ['React Router', { '@react-router/dev': '7', 'react-router': '7' }],
  ])('appends to <head> in app/root for %s', (framework, deps) => {
    const dir = project({ 'package.json': pkg(deps), 'app/root.tsx': root });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    expect(edit.framework).toBe(framework);
    expect(edit.content).toMatch(/<Links \/>\n {8}<script id="subtext-capture" dangerouslySetInnerHTML/);
    parsesAsTsx(edit.content);
  });

  it('falls back on a custom appDirectory', () => {
    const dir = project({
      'package.json': pkg({ '@remix-run/react': '2' }),
      'vite.config.ts': 'export default { plugins: [remix({ appDirectory: "src" })] }',
      'src/root.tsx': root,
    });
    expectFallback(planStaticInstall(dir, SNIPPET), /appDirectory/);
  });
});

describe('Nuxt', () => {
  it('adds app.head.script to defineNuxtConfig', () => {
    const config = `export default defineNuxtConfig({
  devtools: { enabled: true },
  modules: ["@nuxt/ui"],
});
`;
    const dir = project({ 'package.json': pkg({ nuxt: '^3.12.0' }), 'nuxt.config.ts': config });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    expect(edit.content).toMatch(/defineNuxtConfig\(\{\n {2}app: \{\n {4}head: \{\n {6}script: \[\n {8}\{ id: 'subtext-capture', tagPosition: 'head', innerHTML: "/);
    expect(edit.content).toContain('  },\n  devtools: { enabled: true },');
    parsesAsTsx(edit.content);
  });

  it('falls back when an app block already exists', () => {
    const dir = project({
      'package.json': pkg({ nuxt: '3' }),
      'nuxt.config.ts': 'export default defineNuxtConfig({ app: { head: { title: "x" } } })',
    });
    expectFallback(planStaticInstall(dir, SNIPPET), /safe insertion point/);
  });

  it('falls back on Nuxt 2', () => {
    const dir = project({ 'package.json': pkg({ nuxt: '^2.17.0' }), 'nuxt.config.js': 'export default {}' });
    expectFallback(planStaticInstall(dir, SNIPPET), /Nuxt 2/);
  });
});

describe('Gatsby', () => {
  it('creates gatsby-ssr with onRenderBody', () => {
    const dir = project({ 'package.json': pkg({ gatsby: '5' }), 'tsconfig.json': '{}' });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    expect(edit.file).toBe('gatsby-ssr.tsx');
    expect(edit.content).toContain('setHeadComponents([');
    parsesAsTsx(edit.content);
  });

  it('falls back when gatsby-ssr already exists', () => {
    const dir = project({ 'package.json': pkg({ gatsby: '5' }), 'gatsby-ssr.js': 'export const onRenderBody = () => {}' });
    expectFallback(planStaticInstall(dir, SNIPPET), /gatsby-ssr\.js already exists/);
  });
});

describe('pre-check', () => {
  it('reports an existing SDK dependency', () => {
    const dir = project({ 'package.json': pkg({ vite: '5', '@fullstory/browser': '2' }), 'index.html': VITE_HTML });
    expect(planStaticInstall(dir, SNIPPET)).toEqual({ kind: 'already-installed', file: 'package.json (@fullstory/browser)' });
  });

  it('finds an existing snippet in the entry file', () => {
    const dir = project({
      'package.json': pkg({ 'react-scripts': '5' }),
      'public/index.html': VITE_HTML.replace('</head>', `<script>window['_fs_org'] = 'o-1';</script></head>`),
    });
    expect(planStaticInstall(dir, SNIPPET)).toEqual({ kind: 'already-installed', file: 'public/index.html' });
  });

  it('ignores mentions in tests and type declarations', () => {
    const dir = project({
      'package.json': pkg({ vite: '5' }),
      'index.html': VITE_HTML,
      'src/fs.test.ts': `window['_fs_org'] = 'o-1';`,
      'src/global.d.ts': `// window._fs_org = string`,
    });
    expect(planStaticInstall(dir, SNIPPET).kind).toBe('edit');
  });
});

describe('fallbacks', () => {
  it.each([
    ['a monorepo root', { 'package.json': pkg({}, { workspaces: ['apps/*'] }) }, /monorepo/],
    ['React Native', { 'package.json': pkg({ 'react-native': '0.74' }) }, /native SDK/],
    ['an unsupported framework', { 'package.json': pkg({ '@solidjs/start': '1' }) }, /SolidStart/],
    ['nothing recognizable', { 'package.json': pkg({ express: '4' }) }, /couldn't identify/],
    ['a Vite multi-page app', { 'package.json': pkg({ vite: '5' }), 'vite.config.ts': 'export default { build: { rollupOptions: { input: {} } } }', 'index.html': VITE_HTML }, /multiple entry pages/],
    ['two <head> tags', { 'package.json': pkg({ vite: '5' }), 'index.html': VITE_HTML + '<head></head>' }, /safe insertion point/],
    ['a CSP header', { 'package.json': pkg({ vite: '5' }), 'index.html': VITE_HTML, 'vercel.json': { headers: [{ key: 'Content-Security-Policy' }] } }, /Content-Security-Policy.*vercel\.json/],
    ['helmet', { 'package.json': pkg({ vite: '5', helmet: '7' }), 'index.html': VITE_HTML }, /helmet/],
    ['a malformed package.json', { 'package.json': '{ nope' }, /JSON/],
  ])('falls back for %s', (_name, files, reason) => {
    expectFallback(planStaticInstall(project(files as Record<string, string | object>), SNIPPET), reason);
  });

  it('refuses to apply an edit if the file changed after planning', () => {
    const dir = project({ 'package.json': pkg({ vite: '5' }), 'index.html': VITE_HTML });
    const edit = expectEdit(planStaticInstall(dir, SNIPPET));
    fs.writeFileSync(path.join(dir, 'index.html'), VITE_HTML + '<!-- edited -->');
    expect(applyStaticEdit(dir, edit)).toEqual({ ok: false, reason: 'index.html changed while the wizard was running' });
  });
});
