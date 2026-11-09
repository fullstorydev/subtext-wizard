import fs from 'node:fs';
import type { IntegrationSelection } from '../integrations.js';
import { packageRootPath } from '../paths.js';

/**
 * Prompts are assembled from the markdown in templates/:
 *
 *   preamble.md        what Subtext is, shared rules
 *   modes/*.md         how to run (interactive, autonomous, the result file)
 *   steps/<step>.md    one install step, kept as close as possible to the
 *                      matching page on subtext.fullstory.com/install
 *
 * Terminal and headless runs launch a fresh agent per step with
 * buildStepPrompt(). Handoffs where the user drives the agent get the steps
 * joined into one prompt with buildJoinedPrompt().
 */

export const INSTALL_STEPS = ['capture', 'csp', 'identify', 'integrations', 'privacy'] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];

export const SNIPPET_STEPS: InstallStep[] = ['capture', 'csp'];
export const EXTRAS_STEPS: InstallStep[] = ['identify', 'integrations', 'privacy'];

export type PromptMode = 'autonomous' | 'interactive';

export interface StepContext {
  /** Org-specific capture snippet HTML; needed by the capture step. */
  snippet?: string;
  /** Tools to link the session URL into; shapes the integrations step. */
  selection?: IntegrationSelection;
}

function template(...segments: string[]): string {
  return fs.readFileSync(packageRootPath('templates', ...segments), 'utf8').trim();
}

/** What the wizard already knows that narrows a step, appended after the page text. */
function stepNotes(step: InstallStep, ctx: StepContext): string {
  const lines: string[] = [];
  if (step === 'integrations' && ctx.selection) {
    const { integrations, other } = ctx.selection;
    if (integrations.length > 0 || other.length > 0) {
      lines.push('These tools are in this app. Start with them, and still note any others you find:', '');
      for (const integration of integrations) {
        lines.push(`- **${integration.label}**:`, '', '  ```js', ...integration.linkageExample.split('\n').map((l) => `  ${l}`), '  ```', '');
      }
      for (const name of other) {
        lines.push(`- **${name}**: follow its documented way to set a user property or tag.`);
      }
      lines.push('', 'Use `subtextUrl` instead of `subtext_url` where the tool already uses camelCase.');
    }
  }
  return lines.length > 0 ? `### What the setup CLI found\n\n${lines.join('\n').trim()}` : '';
}

function renderStep(step: InstallStep, ctx: StepContext): string {
  let body = template('steps', `${step}.md`);
  if (step === 'capture') {
    const snippet = ctx.snippet;
    if (!snippet) throw new Error('The capture step needs the org snippet.');
    if (!body.includes('{{SNIPPET}}')) throw new Error('templates/steps/capture.md is missing {{SNIPPET}}.');
    // A function, so `$&` and friends in the minified snippet aren't treated as patterns.
    body = body.replace('{{SNIPPET}}', () => snippet);
  }
  return [body, stepNotes(step, ctx)].filter(Boolean).join('\n\n');
}

export function resultFile(step: InstallStep): string {
  return `.subtext/results/${step}.json`;
}

/** One step for one fresh agent run. The agent writes resultFile(step) when it's done. */
export function buildStepPrompt(step: InstallStep, ctx: StepContext): string {
  return [
    template('preamble.md'),
    template('modes', 'autonomous.md'),
    template('modes', 'result.md').replace('{{RESULT_FILE}}', () => resultFile(step)),
    '---',
    renderStep(step, ctx),
  ].join('\n\n') + '\n';
}

/** Several steps in one prompt, for a single session the user (or an outside agent) drives. */
export function buildJoinedPrompt(steps: InstallStep[], ctx: StepContext, mode: PromptMode): string {
  return [
    template('preamble.md'),
    template('modes', mode === 'interactive' ? 'interactive.md' : 'autonomous.md'),
    ...steps.map((step, i) => `---\n\n<!-- Step ${i + 1} of ${steps.length} -->\n\n${renderStep(step, ctx)}`),
  ].join('\n\n') + '\n';
}
