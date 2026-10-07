import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { WizardOptions } from '../config.js';
import { CancelledError } from '../integrations.js';
import { findCsp, findExistingSnippet } from './checks.js';
import { detectFramework } from './frameworks/index.js';
import { readProject } from './project.js';

/**
 * Install the capture snippet with plain code when the project is a framework
 * we recognize and there's exactly one obvious place for it. Anything less
 * certain (unknown framework, monorepo, CSP, ambiguous <head>, a file that
 * won't parse) returns a fallback, and the coding agent does the install.
 */

export interface StaticEdit {
  framework: string;
  /** Path relative to the project dir. */
  file: string;
  /** undefined when we're creating the file. */
  original: string | undefined;
  content: string;
  inserted: string;
}

export type StaticPlan =
  | { kind: 'edit'; edit: StaticEdit }
  | { kind: 'already-installed'; file: string }
  | { kind: 'fallback'; reason: string; framework?: string };

export type StaticOutcome =
  | { status: 'installed'; framework: string; file: string }
  | { status: 'already-installed'; file: string }
  | { status: 'fallback'; reason: string; framework?: string };

export function planStaticInstall(dir: string, snippetHtml: string): StaticPlan {
  try {
    const project = readProject(dir);
    const detection = detectFramework(project);
    const targetFile = detection.ok ? [detection.plan.file] : [];

    const existing = findExistingSnippet(project, targetFile);
    if (existing) return { kind: 'already-installed', file: existing };

    if (!detection.ok) return { kind: 'fallback', reason: detection.reason, framework: detection.framework };
    const { plan } = detection;
    const { framework, file } = plan;

    const csp = findCsp(project, file);
    if (csp) return { kind: 'fallback', reason: `a Content-Security-Policy needs updating (${csp})`, framework };

    const body = snippetBody(snippetHtml);
    if (!body) return { kind: 'fallback', reason: 'unexpected snippet format', framework };
    const snippet = { html: snippetHtml, body };

    const original = 'create' in plan ? undefined : fs.readFileSync(path.join(dir, file), 'utf8');
    const result = 'create' in plan ? plan.create(snippet) : plan.edit(original!, snippet);
    if (!result) {
      return { kind: 'fallback', reason: `couldn't find a single safe insertion point in ${file}`, framework };
    }
    return { kind: 'edit', edit: { framework, file, original, content: result.content, inserted: result.inserted } };
  } catch (error) {
    return { kind: 'fallback', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Inner JS of the fetched `<script>…</script>` snippet. */
function snippetBody(snippetHtml: string): string | undefined {
  const match = /^\s*<script[^>]*>\s*([\s\S]*?)\s*<\/script>\s*$/i.exec(snippetHtml);
  return match?.[1] || undefined;
}

export function applyStaticEdit(dir: string, edit: StaticEdit): { ok: true } | { ok: false; reason: string } {
  const abs = path.join(dir, edit.file);
  try {
    if (edit.original === undefined) {
      // 'wx' refuses to clobber a file that appeared since we planned.
      fs.writeFileSync(abs, edit.content, { flag: 'wx' });
    } else {
      if (fs.readFileSync(abs, 'utf8') !== edit.original) {
        return { ok: false, reason: `${edit.file} changed while the wizard was running` };
      }
      fs.writeFileSync(abs, edit.content);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Interactive wrapper: preview the edit, confirm, write. */
export async function runStaticInstall(
  snippetHtml: string,
  options: WizardOptions,
  onEvent: (event: string, properties?: Record<string, unknown>) => void,
): Promise<StaticOutcome> {
  const plan = planStaticInstall(options.dir, snippetHtml);

  if (plan.kind === 'fallback') {
    onEvent('static_install_fallback', { reason: plan.reason, framework: plan.framework ?? null });
    if (options.debug) p.log.info(pc.dim(`Automatic install skipped: ${plan.reason}`));
    return { status: 'fallback', reason: plan.reason, framework: plan.framework };
  }

  p.log.step(pc.bold('Install the capture snippet'));

  if (plan.kind === 'already-installed') {
    onEvent('static_install_already_installed', { file: plan.file });
    p.log.success(pc.green(pc.bold(`✔ Snippet already installed in ${plan.file}`)));
    return { status: 'already-installed', file: plan.file };
  }

  const { edit } = plan;
  const action = edit.original === undefined ? 'Create' : 'Add the snippet to';
  p.note(previewLines(edit.inserted), `${edit.framework} · ${action.toLowerCase()} ${edit.file}`);

  if (options.printPrompt) {
    p.log.info(pc.dim('--print-prompt: not writing the file.'));
    return { status: 'installed', framework: edit.framework, file: edit.file };
  }

  if (!options.yes) {
    const answer = await p.confirm({ message: `${action} ${edit.file}?` });
    if (p.isCancel(answer)) throw new CancelledError();
    if (!answer) {
      onEvent('static_install_fallback', { reason: 'declined', framework: edit.framework });
      p.log.info('No problem, your coding agent will do the install instead.');
      return { status: 'fallback', reason: 'declined', framework: edit.framework };
    }
  }

  const applied = applyStaticEdit(options.dir, edit);
  if (!applied.ok) {
    onEvent('static_install_fallback', { reason: applied.reason, framework: edit.framework });
    p.log.warn(`Couldn't update ${edit.file} (${applied.reason}). Your coding agent will do the install instead.`);
    return { status: 'fallback', reason: applied.reason, framework: edit.framework };
  }

  onEvent('static_install_completed', { framework: edit.framework, file: edit.file });
  p.log.success(pc.green(pc.bold(`✔ Snippet installed in ${edit.file}`)));
  return { status: 'installed', framework: edit.framework, file: edit.file };
}

// The snippet is a few kB of minified JS nobody needs to read to decide;
// enough lines to show where it goes and what it is.
function previewLines(text: string): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  const shown = lines
    .slice(0, 3)
    .map((line) => pc.green(`+ ${line.length > 80 ? `${line.slice(0, 79)}…` : line}`));
  if (lines.length > 3) shown.push(pc.dim(`  (+${lines.length - 3} more lines, Fullstory capture snippet)`));
  return shown.join('\n');
}
