import { type Project, exists, hasDep, readRel, walkSource } from './project.js';

const SDK_PACKAGES = ['@fullstory/browser', '@fullstory/react-native', '@fullstory/snippet'];

// The same patterns the agent's pre-check uses. Broad matches on "fullstory"
// hit marketing copy and type declarations, so only the snippet's own
// assignments and loader URL count.
const SNIPPET_PATTERNS = [
  /window\[\s*['"]_fs_org['"]\s*\]\s*=/,
  /window\._fs_org\s*=/,
  /_fs_script['"]?\s*\]?\s*=/,
  /fullstory\.com\/s\/fs\.js/,
  /\binit\(\s*\{\s*orgId/,
];

const SOURCE_EXTS = ['.html', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro'];

const isTestOrTypes = (rel: string) => /\.d\.ts$|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])__tests__[\\/]/.test(rel);

/** Where an existing capture install lives, or undefined if there isn't one. */
export function findExistingSnippet(project: Project, extraFiles: string[] = []): string | undefined {
  const sdk = SDK_PACKAGES.find((name) => hasDep(project, name));
  if (sdk) return `package.json (${sdk})`;

  // walkSource skips public/ and build output, so check the entry file itself too.
  for (const rel of extraFiles) {
    if (exists(project, rel) && SNIPPET_PATTERNS.some((re) => re.test(readRel(project, rel)))) return rel;
  }

  let found: string | undefined;
  walkSource(project, '.', SOURCE_EXTS, (rel, content) => {
    if (found || isTestOrTypes(rel)) return;
    if (SNIPPET_PATTERNS.some((re) => re.test(content))) found = rel;
  });
  return found;
}

const CSP_CONFIG_FILES = [
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'middleware.ts',
  'middleware.js',
  'src/middleware.ts',
  'src/middleware.js',
  'vercel.json',
  'netlify.toml',
  '_headers',
  'public/_headers',
  'static/_headers',
  'nuxt.config.ts',
  'nuxt.config.js',
  'astro.config.mjs',
  'astro.config.ts',
  'angular.json',
  'firebase.json',
  'staticwebapp.config.json',
];

const CSP_PATTERN = /content-security-policy|contentSecurityPolicy/i;

/**
 * Whether a Content-Security-Policy is configured anywhere we know to look.
 * Editing a CSP safely depends on how the app builds it, so any hit sends the
 * install to the agent.
 */
export function findCsp(project: Project, targetFile: string): string | undefined {
  // These packages turn a CSP on by default.
  const cspPackage = ['helmet', 'nuxt-security', '@nuxtjs/security'].find((name) => hasDep(project, name));
  if (cspPackage) return `package.json (${cspPackage})`;

  for (const rel of [...CSP_CONFIG_FILES, targetFile]) {
    if (exists(project, rel) && CSP_PATTERN.test(readRel(project, rel))) return rel;
  }

  // SvelteKit configures its CSP under kit.csp.
  for (const rel of ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts']) {
    if (exists(project, rel) && /\bcsp\s*:/.test(readRel(project, rel))) return rel;
  }
  return undefined;
}
