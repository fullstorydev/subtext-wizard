import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a path inside the published package (e.g. templates/…).
 * This file compiles to dist/paths.js, so the package root is one level up.
 */
export function packageRootPath(...segments: string[]): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', ...segments);
}
