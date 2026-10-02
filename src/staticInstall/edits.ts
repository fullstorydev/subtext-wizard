import { parse } from '@babel/parser';
import type { Target } from './detect.js';

/** The `id` on the snippet's script element; next/script requires one. */
export const SCRIPT_ID = 'subtext-capture';

export interface EditResult {
  /** Full new file content. */
  content: string;
  /** Just the added text, for the preview. */
  inserted: string;
}

/** Inner JS of the fetched `<script>…</script>` snippet. */
export function snippetBody(snippetHtml: string): string | undefined {
  const match = /^\s*<script[^>]*>\s*([\s\S]*?)\s*<\/script>\s*$/i.exec(snippetHtml);
  return match?.[1] || undefined;
}

/**
 * Build the edited file for `target`, or undefined when there's no single
 * unambiguous place to put the snippet. `original` is undefined for files we
 * create.
 */
export function buildEdit(
  target: Target,
  original: string | undefined,
  snippetHtml: string,
  body: string,
  typescript: boolean,
): EditResult | undefined {
  switch (target.kind) {
    case 'html':
      return original === undefined ? undefined : insertIntoHtmlHead(original, snippetHtml);
    case 'astro':
      // Astro bundles and hoists plain <script> tags; is:inline keeps it verbatim in <head>.
      return original === undefined
        ? undefined
        : insertIntoHtmlHead(original, snippetHtml.replace(/^\s*<script>/i, '<script is:inline>'));
    case 'next-app':
      return original === undefined ? undefined : editNextAppLayout(original, body);
    case 'next-pages':
      return original === undefined ? createNextDocument(body) : editNextDocument(original, body);
    case 'jsx-head':
      return original === undefined ? undefined : editJsxHead(original, body);
    case 'nuxt-config':
      return original === undefined ? undefined : editNuxtConfig(original, body);
    case 'gatsby-ssr':
      return original === undefined ? createGatsbySsr(body, typescript) : undefined;
  }
}

// ---------- HTML ----------

export function insertIntoHtmlHead(content: string, snippetHtml: string): EditResult | undefined {
  const opens = content.match(/<head[\s>]/gi) ?? [];
  const closes = content.match(/<\/head\s*>/gi) ?? [];
  if (opens.length !== 1 || closes.length !== 1) return undefined;

  const closeAt = content.search(/<\/head\s*>/i);
  const { lineStart, prefix } = lineBefore(content, closeAt);
  const closeIndent = indentOf(content, closeAt);
  const childIndent = closeIndent + guessIndentUnit(content);
  const block = indentLines(snippetHtml.trim(), childIndent);

  return /^\s*$/.test(prefix)
    ? splice(content, lineStart, `${block}\n`)
    : splice(content, closeAt, `\n${block}\n${closeIndent}`);
}

// ---------- JSX / TS ----------

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

interface JsxElement extends AstNode {
  openingElement: AstNode & { name: AstNode & { name?: string }; selfClosing: boolean };
  closingElement: AstNode | null;
  children: AstNode[];
}

interface Insertion {
  at: number;
  text: string;
}

function parseModule(code: string): AstNode | undefined {
  try {
    return parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    }) as unknown as AstNode;
  } catch {
    return undefined;
  }
}

const SKIP_KEYS = new Set(['loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node || typeof node !== 'object' || typeof (node as AstNode).type !== 'string') return;
  visit(node as AstNode);
  for (const [key, value] of Object.entries(node)) {
    if (!SKIP_KEYS.has(key) && value && typeof value === 'object') walk(value, visit);
  }
}

function jsxElements(ast: AstNode, name: string): JsxElement[] {
  const found: JsxElement[] = [];
  walk(ast, (node) => {
    if (node.type !== 'JSXElement') return;
    const el = node as JsxElement;
    if (el.openingElement.name.type === 'JSXIdentifier' && el.openingElement.name.name === name) found.push(el);
  });
  return found;
}

function only<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/** Insertion that adds `text` as the last child of `el`. */
function appendChild(code: string, el: JsxElement, text: string): Insertion | undefined {
  if (el.openingElement.selfClosing || !el.closingElement) return undefined;
  const closeAt = el.closingElement.start;
  const { lineStart, prefix } = lineBefore(code, closeAt);
  const closeIndent = indentOf(code, closeAt);
  const childIndent = childIndentOf(code, el) ?? closeIndent + guessIndentUnit(code);
  return /^\s*$/.test(prefix)
    ? { at: lineStart, text: `${childIndent}${text}\n` }
    : { at: closeAt, text: `\n${childIndent}${text}\n${closeIndent}` };
}

/** Insertion that adds `text` as the first child of `el`. */
function prependChild(code: string, el: JsxElement, text: string): Insertion | undefined {
  if (el.openingElement.selfClosing) return undefined;
  const childIndent = childIndentOf(code, el) ?? indentOf(code, el.start) + guessIndentUnit(code);
  return { at: el.openingElement.end, text: `\n${childIndent}${text}` };
}

function childIndentOf(code: string, el: JsxElement): string | undefined {
  for (const child of el.children) {
    if (child.type === 'JSXText') continue;
    const { prefix } = lineBefore(code, child.start);
    if (/^\s*$/.test(prefix)) return prefix;
  }
  return undefined;
}

interface ImportInfo {
  source: string;
  defaultLocal?: string;
  named: Map<string, string>;
}

function imports(ast: AstNode): { list: ImportInfo[]; lastEnd?: number; quote: string } {
  const program = (ast as unknown as { program: { body: AstNode[] } }).program;
  const list: ImportInfo[] = [];
  let lastEnd: number | undefined;
  let quote = '"';
  for (const stmt of program.body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const source = stmt.source as AstNode & { value: string; extra?: { raw?: string } };
    if (lastEnd === undefined) quote = source.extra?.raw?.[0] === "'" ? "'" : '"';
    const info: ImportInfo = { source: source.value, named: new Map() };
    for (const spec of stmt.specifiers as Array<AstNode & { local: { name: string }; imported?: { name?: string; value?: string } }>) {
      if (spec.type === 'ImportDefaultSpecifier') info.defaultLocal = spec.local.name;
      if (spec.type === 'ImportSpecifier') {
        info.named.set(spec.imported?.name ?? spec.imported?.value ?? spec.local.name, spec.local.name);
      }
    }
    list.push(info);
    lastEnd = stmt.end;
  }
  return { list, lastEnd, quote };
}

/** Every identifier in the module: a blunt but safe stand-in for scope analysis. */
function declaredNames(ast: AstNode): Set<string> {
  const names = new Set<string>();
  walk(ast, (node) => {
    if (node.type === 'Identifier' && typeof node.name === 'string') names.add(node.name);
  });
  return names;
}

function applyInsertions(code: string, insertions: Insertion[]): string {
  return [...insertions]
    .sort((a, b) => b.at - a.at)
    .reduce((acc, ins) => splice(acc, ins.at, ins.text).content, code);
}

function finishJsEdit(original: string, insertions: Insertion[], preview: string): EditResult | undefined {
  const content = applyInsertions(original, insertions);
  // Never hand back a file that no longer parses.
  return parseModule(content) ? { content, inserted: preview } : undefined;
}

const htmlLiteral = (body: string) => JSON.stringify(body);

/** `<script id dangerouslySetInnerHTML>` element for JSX files. */
function jsxScript(tag: string, body: string, extraAttrs = ''): string {
  return `<${tag} id="${SCRIPT_ID}"${extraAttrs} dangerouslySetInnerHTML={{ __html: ${htmlLiteral(body)} }} />`;
}

export function editNextAppLayout(original: string, body: string): EditResult | undefined {
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
    insertions.push(lastEnd === undefined ? { at: directivesEnd(ast, original), text: `${line}\n\n` } : { at: lastEnd, text: `\n${line}` });
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

function directivesEnd(ast: AstNode, code: string): number {
  const directives = (ast as unknown as { program: { directives: AstNode[] } }).program.directives;
  if (directives.length === 0) return 0;
  const end = directives[directives.length - 1].end;
  // Land after the directive's own line break.
  const newline = code.indexOf('\n', end);
  return newline === -1 ? code.length : newline + 1;
}

export function editNextDocument(original: string, body: string): EditResult | undefined {
  const ast = parseModule(original);
  if (!ast) return undefined;
  const headLocal = imports(ast).list.find((i) => i.source === 'next/document')?.named.get('Head');
  if (!headLocal) return undefined;
  const head = only(jsxElements(ast, headLocal));
  if (!head) return undefined;
  const element = jsxScript('script', body);
  const child = appendChild(original, head, element);
  return child ? finishJsEdit(original, [child], element) : undefined;
}

export function editJsxHead(original: string, body: string): EditResult | undefined {
  const ast = parseModule(original);
  if (!ast) return undefined;
  const head = only(jsxElements(ast, 'head'));
  if (!head) return undefined;
  const element = jsxScript('script', body);
  const child = appendChild(original, head, element);
  return child ? finishJsEdit(original, [child], element) : undefined;
}

export function createNextDocument(body: string): EditResult {
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

export function createGatsbySsr(body: string, typescript: boolean): EditResult {
  const signature = typescript
    ? `import type { GatsbySSR } from "gatsby";

export const onRenderBody: GatsbySSR["onRenderBody"] = ({ setHeadComponents }) => {`
    : `export const onRenderBody = ({ setHeadComponents }) => {`;
  const content = `import * as React from "react";
${signature}
  setHeadComponents([
    <script key="${SCRIPT_ID}" id="${SCRIPT_ID}" dangerouslySetInnerHTML={{ __html: ${htmlLiteral(body)} }} />,
  ]);
};
`;
  return { content, inserted: content };
}

export function editNuxtConfig(original: string, body: string): EditResult | undefined {
  const ast = parseModule(original);
  if (!ast) return undefined;
  const program = (ast as unknown as { program: { body: AstNode[] } }).program;
  const exported = program.body.find((s) => s.type === 'ExportDefaultDeclaration')?.declaration as AstNode | undefined;
  if (!exported) return undefined;

  let config: AstNode | undefined;
  if (exported.type === 'ObjectExpression') config = exported;
  if (exported.type === 'CallExpression') {
    const callee = exported.callee as AstNode & { name?: string };
    const arg = (exported.arguments as AstNode[])[0];
    if (callee.type === 'Identifier' && callee.name === 'defineNuxtConfig' && arg?.type === 'ObjectExpression') {
      config = arg;
    }
  }
  if (!config) return undefined;

  const properties = config.properties as Array<AstNode & { key?: AstNode & { name?: string; value?: string } }>;
  const keyName = (p: (typeof properties)[number]) => p.key?.name ?? p.key?.value;
  // An existing `app` block (or a spread that might hold one) needs a merge.
  if (properties.some((p) => p.type === 'SpreadElement' || keyName(p) === 'app')) return undefined;

  const unit = guessIndentUnit(original);
  const indent = properties[0] ? indentOf(original, properties[0].start) : unit;
  const lines = [
    `app: {`,
    `${unit}head: {`,
    `${unit}${unit}script: [`,
    `${unit}${unit}${unit}{ id: '${SCRIPT_ID}', tagPosition: 'head', innerHTML: ${htmlLiteral(body)} },`,
    `${unit}${unit}],`,
    `${unit}},`,
    `},`,
  ];
  const block = lines.map((l) => indent + l).join('\n');
  const openBrace = config.start + 1;
  const insertion: Insertion =
    properties.length === 0
      ? { at: openBrace, text: `\n${block}\n${indentOf(original, config.start)}` }
      : { at: openBrace, text: `\n${block}` };
  return finishJsEdit(original, [insertion], lines.join('\n'));
}

// ---------- text helpers ----------

function splice(content: string, at: number, text: string): EditResult {
  return { content: content.slice(0, at) + text + content.slice(at), inserted: text };
}

function lineBefore(content: string, pos: number): { lineStart: number; prefix: string } {
  const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
  return { lineStart, prefix: content.slice(lineStart, pos) };
}

function indentOf(content: string, pos: number): string {
  const { prefix } = lineBefore(content, pos);
  return /^[ \t]*/.exec(prefix)![0];
}

/** Two spaces unless the file is clearly indented with tabs or four spaces. */
function guessIndentUnit(content: string): string {
  const indents = content.match(/^[ \t]+(?=\S)/gm) ?? [];
  if (indents.filter((i) => i.startsWith('\t')).length > indents.length / 2) return '\t';
  const spaced = indents.filter((i) => !i.includes('\t')).map((i) => i.length);
  if (spaced.length > 0 && spaced.every((n) => n % 4 === 0)) return '    ';
  return '  ';
}

function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? indent + line : line))
    .join('\n');
}
