import { exists, hasDep, readRel } from '../project.js';
import { htmlEntry } from './htmlEntry.js';
import { type Framework, fail } from './types.js';

const NAME = 'Angular';

interface AngularJson {
  projects?: Record<string, { architect?: { build?: { options?: { index?: unknown } } } }>;
}

export const angular: Framework = {
  name: NAME,
  matches: (project) => hasDep(project, '@angular/core'),
  detect(project) {
    if (exists(project, 'angular.json')) {
      const config = JSON.parse(readRel(project, 'angular.json')) as AngularJson;
      const indexes = Object.values(config.projects ?? {})
        .map((p) => indexPath(p.architect?.build?.options?.index))
        .filter((index): index is string => index !== undefined);
      if (new Set(indexes).size > 1) return fail('angular.json has several apps', NAME);
      if (indexes.length === 1) return htmlEntry(project, NAME, [indexes[0]]);
    }
    return htmlEntry(project, NAME, ['src/index.html']);
  },
};

// `index` is either a path or { input, output }.
function indexPath(index: unknown): string | undefined {
  if (typeof index === 'string') return index;
  if (typeof index === 'object' && index !== null && 'input' in index) return String((index as { input: unknown }).input);
  return undefined;
}
