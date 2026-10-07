import { insertIntoHtmlHead } from '../edit/html.js';
import { hasDep, walkSource } from '../project.js';
import { type Framework, fail } from './types.js';

const NAME = 'Astro';

export const astro: Framework = {
  name: NAME,
  matches: (project) => hasDep(project, 'astro'),
  detect(project) {
    const candidates: string[] = [];
    const complete = walkSource(project, 'src', ['.astro'], (rel, content) => {
      if (/<\/head>/i.test(content)) candidates.push(rel);
    });
    if (!complete) return fail('too many files to scan', NAME);
    if (candidates.length === 0) return fail('no layout with a <head> found', NAME);
    if (candidates.length > 1) {
      return fail(`${candidates.length} files render a <head> (${candidates.slice(0, 3).join(', ')})`, NAME);
    }
    return {
      ok: true,
      plan: {
        framework: NAME,
        file: candidates[0],
        // Astro bundles and hoists plain <script> tags; is:inline keeps it verbatim in <head>.
        edit: (original, { html }) => insertIntoHtmlHead(original, html.replace(/^\s*<script>/i, '<script is:inline>')),
      },
    };
  },
};
