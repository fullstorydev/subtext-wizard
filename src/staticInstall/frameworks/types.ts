import type { EditResult } from '../edit/text.js';
import type { Project } from '../project.js';

export interface Snippet {
  /** The fetched `<script>…</script>` block. */
  html: string;
  /** Its inner JS, for frameworks that take the script as a string. */
  body: string;
}

/** Where the snippet goes in one project, and how to put it there. */
export type Plan = { framework: string; file: string } & (
  | {
      /** Edit an existing file; undefined when there's no single safe spot. */
      edit(original: string, snippet: Snippet): EditResult | undefined;
    }
  | {
      /** Create `file`, which doesn't exist yet. */
      create(snippet: Snippet): EditResult;
    }
);

export type Detection = { ok: true; plan: Plan } | { ok: false; reason: string; framework?: string };

export interface Framework {
  name: string;
  /** Whether package.json says the project uses this framework. Checked in registry order. */
  matches(project: Project): boolean;
  detect(project: Project): Detection;
}

export const fail = (reason: string, framework?: string): Detection => ({ ok: false, reason, framework });

export const JS_EXTS = ['tsx', 'jsx', 'ts', 'js', 'mjs'];
export const withExts = (base: string, exts = JS_EXTS) => exts.map((ext) => `${base}.${ext}`);
