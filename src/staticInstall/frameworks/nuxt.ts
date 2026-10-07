import { type AstNode, type Insertion, SCRIPT_ID, finishJsEdit, jsString, parseModule, programBody } from '../edit/js.js';
import { type EditResult, guessIndentUnit, indentOf } from '../edit/text.js';
import { depMajor, firstExisting, hasDep } from '../project.js';
import { type Framework, fail, withExts } from './types.js';

const NAME = 'Nuxt';

export const nuxt: Framework = {
  name: NAME,
  matches: (project) => hasDep(project, 'nuxt'),
  detect(project) {
    const major = depMajor(project, 'nuxt');
    if (major !== undefined && major < 3) return fail('Nuxt 2 is not covered by the automatic install', NAME);
    const config = firstExisting(project, withExts('nuxt.config', ['ts', 'js', 'mjs']));
    if (!config) return fail('no nuxt.config file found', NAME);
    return { ok: true, plan: { framework: NAME, file: config, edit: (original, { body }) => editConfig(original, body) } };
  },
};

/** Add `app.head.script` to the config object, unless an `app` block is already there. */
function editConfig(original: string, body: string): EditResult | undefined {
  const ast = parseModule(original);
  if (!ast) return undefined;
  const exported = programBody(ast).find((s) => s.type === 'ExportDefaultDeclaration')?.declaration as
    | AstNode
    | undefined;
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
    `${unit}${unit}${unit}{ id: '${SCRIPT_ID}', tagPosition: 'head', innerHTML: ${jsString(body)} },`,
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
