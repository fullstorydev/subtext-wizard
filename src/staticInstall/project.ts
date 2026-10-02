import fs from 'node:fs';
import path from 'node:path';

export interface Project {
  dir: string;
  hasPackageJson: boolean;
  /** dependencies + devDependencies, name → version range. */
  deps: Record<string, string>;
  /** Raw package.json, for fields like `workspaces`. */
  pkg: Record<string, unknown>;
  typescript: boolean;
}

export function readProject(dir: string): Project {
  const pkgPath = path.join(dir, 'package.json');
  let pkg: Record<string, unknown> = {};
  const hasPackageJson = fs.existsSync(pkgPath);
  if (hasPackageJson) {
    // A malformed package.json throws here, and the caller treats any throw as
    // "can't decide statically".
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  }
  const deps = {
    ...(pkg.devDependencies as Record<string, string> | undefined),
    ...(pkg.dependencies as Record<string, string> | undefined),
  };
  return {
    dir,
    hasPackageJson,
    deps,
    pkg,
    typescript: fs.existsSync(path.join(dir, 'tsconfig.json')) || 'typescript' in deps,
  };
}

export function hasDep(project: Project, ...names: string[]): boolean {
  return names.some((name) => name in project.deps);
}

/** Major version from a range like "^3.12.0" or "~2.1"; undefined for tags/workspace refs. */
export function depMajor(project: Project, name: string): number | undefined {
  const match = /(\d+)/.exec(project.deps[name] ?? '');
  return match ? Number(match[1]) : undefined;
}

export function exists(project: Project, rel: string): boolean {
  return fs.existsSync(path.join(project.dir, rel));
}

/** First of `candidates` (relative paths) that exists, or undefined. */
export function firstExisting(project: Project, candidates: string[]): string | undefined {
  return candidates.find((rel) => exists(project, rel));
}

export function readRel(project: Project, rel: string): string {
  return fs.readFileSync(path.join(project.dir, rel), 'utf8');
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.vercel',
  '.netlify',
  '.cache',
  '.turbo',
  'public',
  'vendor',
]);

// Big enough for any real app's source tree, small enough that a run from the
// wrong directory (say, $HOME) gives up quickly instead of crawling the disk.
const MAX_FILES = 8_000;
const MAX_FILE_BYTES = 1_000_000;

/**
 * Visit source files under `root` (relative to the project) with one of
 * `exts`. Returns false if the walk hit MAX_FILES before finishing, so callers
 * can tell "not found" from "didn't look everywhere".
 */
export function walkSource(
  project: Project,
  root: string,
  exts: string[],
  visit: (rel: string, content: string) => void,
): boolean {
  let seen = 0;
  const stack = [root];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(project.dir, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(rel);
        continue;
      }
      if (!entry.isFile() || !exts.some((ext) => entry.name.endsWith(ext))) continue;
      if (++seen > MAX_FILES) return false;
      const abs = path.join(project.dir, rel);
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
        visit(rel, fs.readFileSync(abs, 'utf8'));
      } catch {
        // unreadable file: not ours to worry about
      }
    }
  }
  return true;
}
