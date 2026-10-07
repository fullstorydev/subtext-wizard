import fs from 'node:fs';
import path from 'node:path';
import { insertIntoHtmlHead } from '../edit/html.js';
import { type Project, firstExisting } from '../project.js';
import { type Detection, fail } from './types.js';

/** Shared by every framework whose entry point is a plain HTML file. */
export function htmlEntry(project: Project, framework: string, candidates: string[]): Detection {
  const file = firstExisting(project, candidates);
  if (!file) return fail(`expected ${candidates.join(' or ')}`, framework);
  if (!fs.statSync(path.join(project.dir, file)).isFile()) return fail(`${file} is not a file`, framework);
  return {
    ok: true,
    plan: { framework, file, edit: (original, snippet) => insertIntoHtmlHead(original, snippet.html) },
  };
}
