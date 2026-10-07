import { parse } from '@babel/parser';
import { type EditResult, guessIndentUnit, indentOf, lineBefore, splice } from './text.js';

/**
 * Just enough AST to find insertion points in JS/TS/JSX files. Edits are made
 * as text splices at node offsets, so the rest of the file keeps its exact
 * formatting, and the result has to parse again before it's used.
 */

/** The `id` on the snippet's script element; next/script requires one. */
export const SCRIPT_ID = 'subtext-capture';

export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface JsxElement extends AstNode {
  openingElement: AstNode & { name: AstNode & { name?: string }; selfClosing: boolean };
  closingElement: AstNode | null;
  children: AstNode[];
}

export interface Insertion {
  at: number;
  text: string;
}

export function parseModule(code: string): AstNode | undefined {
  try {
    return parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    }) as unknown as AstNode;
  } catch {
    return undefined;
  }
}

export function programBody(ast: AstNode): AstNode[] {
  return (ast as unknown as { program: { body: AstNode[] } }).program.body;
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

export function jsxElements(ast: AstNode, name: string): JsxElement[] {
  const found: JsxElement[] = [];
  walk(ast, (node) => {
    if (node.type !== 'JSXElement') return;
    const el = node as JsxElement;
    if (el.openingElement.name.type === 'JSXIdentifier' && el.openingElement.name.name === name) found.push(el);
  });
  return found;
}

export function only<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/** Insertion that adds `text` as the last child of `el`. */
export function appendChild(code: string, el: JsxElement, text: string): Insertion | undefined {
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
export function prependChild(code: string, el: JsxElement, text: string): Insertion | undefined {
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

export interface ImportInfo {
  source: string;
  defaultLocal?: string;
  /** imported name → local name */
  named: Map<string, string>;
}

export function imports(ast: AstNode): { list: ImportInfo[]; lastEnd?: number; quote: string } {
  const list: ImportInfo[] = [];
  let lastEnd: number | undefined;
  let quote = '"';
  for (const stmt of programBody(ast)) {
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
export function declaredNames(ast: AstNode): Set<string> {
  const names = new Set<string>();
  walk(ast, (node) => {
    if (node.type === 'Identifier' && typeof node.name === 'string') names.add(node.name);
  });
  return names;
}

/** Offset just past the file's directives ("use client" etc.), where new imports can go. */
export function directivesEnd(ast: AstNode, code: string): number {
  const directives = (ast as unknown as { program: { directives: AstNode[] } }).program.directives;
  if (directives.length === 0) return 0;
  const end = directives[directives.length - 1].end;
  // Land after the directive's own line break.
  const newline = code.indexOf('\n', end);
  return newline === -1 ? code.length : newline + 1;
}

function applyInsertions(code: string, insertions: Insertion[]): string {
  return [...insertions]
    .sort((a, b) => b.at - a.at)
    .reduce((acc, ins) => splice(acc, ins.at, ins.text).content, code);
}

export function finishJsEdit(original: string, insertions: Insertion[], preview: string): EditResult | undefined {
  const content = applyInsertions(original, insertions);
  // Never hand back a file that no longer parses.
  return parseModule(content) ? { content, inserted: preview } : undefined;
}

export const jsString = (body: string) => JSON.stringify(body);

/** `<script id dangerouslySetInnerHTML>` element for JSX files. */
export function jsxScript(tag: string, body: string, extraAttrs = ''): string {
  return `<${tag} id="${SCRIPT_ID}"${extraAttrs} dangerouslySetInnerHTML={{ __html: ${jsString(body)} }} />`;
}

/** Add `script` as the last child of the file's single `<head>` element. */
export function appendToJsxHead(original: string, headName: string, script: string): EditResult | undefined {
  const ast = parseModule(original);
  if (!ast) return undefined;
  const head = only(jsxElements(ast, headName));
  if (!head) return undefined;
  const child = appendChild(original, head, script);
  return child ? finishJsEdit(original, [child], script) : undefined;
}
