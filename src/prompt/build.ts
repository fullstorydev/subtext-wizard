import fs from 'node:fs';
import { TELEMETRY_ENDPOINT } from '../config.js';
import type { IntegrationSelection } from '../integrations.js';
import { packageRootPath } from '../paths.js';

export type PromptMode = 'headless' | 'interactive';

export interface BuildPromptInput {
  /** Org-specific capture snippet HTML fetched from the API. */
  snippet: string;
  selection: IntegrationSelection;
  mode: PromptMode;
  /** Correlates agent-side telemetry with this wizard run. */
  runId: string;
  /** Telemetry checkpoints from inside the agent run. Off when telemetry is disabled. */
  telemetryEnabled: boolean;
}

const HEADLESS_MODE_SECTION = `## Mode: autonomous (headless)

You are running non-interactively inside the Subtext setup CLI. The user cannot answer questions mid-run. Wherever this document says to present a plan, wait for approval, or confirm before writing: do NOT wait — apply your best judgment, keep every change minimal and reviewable, and record what you did (plus anything you would have asked) in a final report written to \`./subtext-setup-report.md\`. If a step is impossible without user input, skip it and explain why in the report.`;

const INTERACTIVE_MODE_SECTION = `## Mode: interactive

Work through the steps with the user in this conversation, honoring every approval gate below.`;

function telemetrySection(runId: string): string {
  return `## Telemetry checkpoints

As you finish each step below, fire a non-blocking background telemetry ping so setup progress is visible to the Subtext team:

\`\`\`sh
curl -s -X POST '${TELEMETRY_ENDPOINT}' \\
  -H 'Content-Type: application/json' \\
  -d '{"event":"agent_step_completed","run_id":"${runId}","step":"<step number, 1-8>"}' \\
  > /dev/null 2>&1 &
\`\`\`

Fire one after each of Steps 1–8. Telemetry must never block or delay the install — if \`curl\` is unavailable or the request fails, skip silently and move on.`;
}

function integrationsSection(selection: IntegrationSelection): string {
  const { integrations, other } = selection;
  if (integrations.length === 0 && other.length === 0) {
    return `## Target integrations

The user did not select any analytics or product tools during setup. In Step 2, detect whatever is present using your own search of \`package.json\` and the codebase, and link the Subtext URL into anything you find in Step 6.`;
  }

  const lines: string[] = [
    '## Target integrations',
    '',
    'During setup the user said this app uses the tools below. Prioritize these in Step 2 detection and Step 6 linkage — the user expects them to exist. Still note any other analytics SDK you happen to find.',
    '',
  ];
  for (const integration of integrations) {
    const hints: string[] = [];
    if (integration.packages.length > 0) {
      hints.push(`packages: ${integration.packages.map((pkg) => `\`${pkg}\``).join(', ')}`);
    }
    if (integration.globals?.length) {
      hints.push(`or the \`window.${integration.globals[0]}\` global from a script-tag install`);
    }
    lines.push(`- **${integration.label}** — look for ${hints.join('; ')}.`);
  }
  for (const name of other) {
    lines.push(
      `- **${name}** — the user named this tool themselves. Find its SDK in the codebase, then follow that tool's documented pattern for setting a user property/trait/tag and attach the Subtext URL as \`subtext_url\` (or the camelCase equivalent if that matches the tool's convention).`,
    );
  }
  return lines.join('\n');
}

function linkageExamples(selection: IntegrationSelection): string {
  const examples = selection.integrations.map((i) => i.linkageExample);
  if (examples.length === 0) {
    examples.push(
      `// Generic example — adapt to each tool's user-property API
analytics.identify(user.id, { subtext_url: subtextUrl });`,
    );
  }
  // Indent to sit inside the template's code fence (3-space list indent).
  return examples
    .join('\n\n')
    .split('\n')
    .map((line) => (line ? `   ${line}` : line))
    .join('\n');
}

export function buildInstallPrompt(input: BuildPromptInput): string {
  const template = fs.readFileSync(
    packageRootPath('templates', 'install-prompt.md'),
    'utf8',
  );
  const headless = input.mode === 'headless';

  const replacements: Record<string, string> = {
    MODE_SECTION: headless ? HEADLESS_MODE_SECTION : INTERACTIVE_MODE_SECTION,
    TELEMETRY_SECTION: input.telemetryEnabled ? telemetrySection(input.runId) : '',
    INTEGRATIONS_SECTION: integrationsSection(input.selection),
    SNIPPET: input.snippet,
    INTEGRATION_LINKAGE_EXAMPLES: linkageExamples(input.selection),
    PLAN_GATE: headless ? '' : ', wait for approval',
    PLAN_GATE_DETAIL: headless
      ? 'Record this plan in your report, then proceed directly to Step 4.'
      : '**Wait for the user to approve the plan before proceeding to Step 4.** Do not make any code changes during exploration or planning.',
    IDENTITY_GATE: headless
      ? 'Insert the call with the values you determined, and record the call site and values in your report.'
      : 'Show the user the call site and the values you intend to use before writing. Wait for confirmation, then insert.',
    PRIVACY_GATE: headless
      ? 'For each element you tag, record the file, line, and the class you added in your report.'
      : 'For each element you want to tag, propose the file, line, and the class you intend to add. Wait for the user to confirm before writing.',
    EXPLAIN_VERB: headless
      ? 'include this in your report'
      : 'tell the user',
  };

  let prompt = template;
  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }
  // Collapse blank runs left by empty sections.
  return prompt.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
