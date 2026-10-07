import path from 'node:path';
import {
  type Insertion,
  appendChild,
  appendToJsxHead,
  declaredNames,
  directivesEnd,
  finishJsEdit,
  imports,
  jsxElements,
  jsxScript,
  only,
  parseModule,
  prependChild,
} from '../edit/js.js';
import type { EditResult } from '../edit/text.js';
import { type Project, exists, firstExisting, hasDep, walkSource } from '../project.js';
import { type Detection, type Framework, fail, withExts } from './types.js';

const NAME = 'Next.js';

export const next: Framework = {
  name: NAME,
  matches: (project) => hasDep(project, 'next'),
  detect(project) {
    return detectAppRouter(project) ?? detectPagesRouter(project);
  },
};

function detectAppRouter(project: Project): Detection | undefined {
  // Next ignores src/app when app/ exists, so check the root first.
  for (const base of ['', 'src/']) {
    const appDir = `${base}app`;
    const layout = firstExisting(project, withExts(`${appDir}/layout`, ['tsx', 'jsx', 'js']));
    if (layout) {
      // A root layout only covers App Router pages; any Pages Router pages
      // alongside it would go uncaptured.
      if (hasPagesRouterPages(project, `${base}pages`)) {
        return fail('the project mixes the App Router and Pages Router', NAME);
      }
      return { ok: true, plan: { framework: `${NAME} (App Router)`, file: layout, edit: editAppLayout } };
    }
    if (exists(project, appDir) && !exists(project, `${base}pages`)) {
      return fail('no root app/layout file (multiple root layouts?)', NAME);
    }
  }
  return undefined;
}

function detectPagesRouter(project: Project): Detection {
  const framework = `${NAME} (Pages Router)`;
  for (const base of ['', 'src/']) {
    const pagesDir = `${base}pages`;
    if (!exists(project, pagesDir)) continue;
    const doc = firstExisting(project, withExts(`${pagesDir}/_document`, ['tsx', 'jsx', 'js', 'ts']));
    if (doc) return { ok: true, plan: { framework, file: doc, edit: editDocument } };
    const file = `${pagesDir}/_document.${project.typescript ? 'tsx' : 'js'}`;
    return { ok: true, plan: { framework, file, create: ({ body }) => createDocument(body) } };
  }
  return fail('no app/ or pages/ directory found', NAME);
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

function editAppLayout(original: string, { body }: { body: string }): EditResult | undefined {
  const ast = parseModule(original);
  if (!ast) return undefined;
  const { list, lastEnd, quote } = imports(ast);
  const existing = list.find((i) => i.source === 'next/script')?.defaultLocal;

  let local = existing;
  const insertions: Insertion[] = [];
  if (!local) {
    if (declaredNames(ast).has('Script')) return undefined;
    local = 'Script';
    const semi = lastEnd === undefined || original.slice(0, lastEnd).trimEnd().endsWith(';');
    const line = `import Script from ${quote}next/script${quote}${semi ? ';' : ''}`;
    insertions.push(
      lastEnd === undefined ? { at: directivesEnd(ast, original), text: `${line}\n\n` } : { at: lastEnd, text: `\n${line}` },
    );
  }

  // beforeInteractive scripts are hoisted into <head> by Next wherever they sit
  // in the root layout, so <body> works when the layout has no <head>.
  const element = jsxScript(local, body, ' strategy="beforeInteractive"');
  const head = only(jsxElements(ast, 'head'));
  const bodyEl = only(jsxElements(ast, 'body'));
  const child = head ? appendChild(original, head, element) : bodyEl ? prependChild(original, bodyEl, element) : undefined;
  if (!child) return undefined;
  insertions.push(child);

  const preview = [...(existing ? [] : [`import Script from "next/script";`]), element].join('\n');
  return finishJsEdit(original, insertions, preview);
}

function editDocument(original: string, { body }: { body: string }): EditResult | undefined {
  const ast = parseModule(original);
  if (!ast) return undefined;
  const headLocal = imports(ast).list.find((i) => i.source === 'next/document')?.named.get('Head');
  if (!headLocal) return undefined;
  return appendToJsxHead(original, headLocal, jsxScript('script', body));
}

function createDocument(body: string): EditResult {
  const content = `import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html>
      <Head>
        ${jsxScript('script', body)}
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
`;
  return { content, inserted: content };
}
