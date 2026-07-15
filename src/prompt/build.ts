import fs from 'node:fs';
import { TELEMETRY_MARKER_PREFIX } from '../agents/telemetry-marker.js';
import type { IntegrationSelection } from '../integrations.js';
import { packageRootPath } from '../paths.js';

export type PromptMode = 'headless' | 'interactive';

/**
 * How the prompt instructs the agent to report telemetry:
 * - 'mcp'    — GUI handoffs where the Subtext plugin is set up; the agent logs
 *   through the `telemetry-event` MCP tool.
 * - 'stdout' — terminal runs; the agent PRINTS per-step markers to stdout that
 *   the wizard parses and sends with its own token. The agent never holds a
 *   credential, so a malicious install subprocess has nothing to steal.
 * - 'none'   — telemetry declined/disabled, a GUI handoff without the plugin,
 *   or a manual handoff. The wizard reports what it can (start/complete) itself.
 */
export type PromptTelemetry = 'mcp' | 'stdout' | 'none';

export interface BuildPromptInput {
  /** Org-specific capture snippet HTML fetched from the API. */
  snippet: string;
  selection: IntegrationSelection;
  mode: PromptMode;
  telemetry: PromptTelemetry;
}

const HEADLESS_MODE_SECTION = `## Mode: autonomous (headless)

You are running non-interactively inside the Subtext setup CLI. The user cannot answer questions mid-run. Wherever this document says to present a plan, wait for approval, or confirm before writing: do NOT wait — apply your best judgment, keep every change minimal and reviewable, and record what you did (plus anything you would have asked) in a final report written to \`./subtext-setup-report.md\`. If a step is impossible without user input, skip it and explain why in the report.`;

const INTERACTIVE_MODE_SECTION = `## Mode: interactive

Work through the steps with the user in this conversation, honoring every approval gate below.`;

/** Step/metadata table shared by both telemetry sections, so the two
 * transports can never drift. Steps 1–7 are agent-reportable over either
 * transport; the Step 8 `complete` row is MCP-only (for terminal runs the
 * wizard owns `complete` itself). Keep field names in sync with
 * WorkflowEventMetadata (telemetry.ts) and the allowlist in
 * telemetry-marker.ts. */
const STEP_TABLE = `| After | \`step\` | \`metadata\` fields |
|-------|---------|--------------------|
| Step 1 | \`precheck\` | \`already_installed\` (bool) |
| Step 2 | \`explore\` | \`framework\` (string), \`csp_present\` (bool) |
| Step 3 | \`plan\` | \`approved\` (bool) |
| Step 4 | \`install\` | \`framework\` (string), \`csp_modified\` (bool) |
| Step 5 | \`identify\` | \`identity_added\` (bool) |
| Step 6 | \`link_analytics\` | \`analytics_providers\` (string[] — names of every analytics/session-replay/error-monitoring/feature-flag SDK found) |
| Step 7 | \`mask_pii\` | \`masked_count\` (int), \`privacy_check\` (bool) |`;

const COMPLETE_ROW = `| Step 8 | \`complete\` | \`total_duration_ms\` (int), \`total_tokens\` (int) |`;

/**
 * GUI-handoff variant: the agent logs milestones through the Subtext
 * plugin's `telemetry-event` MCP tool. Adapted from the settings-ui setup
 * prompt (mn#107606), minus the consent ask — the wizard already asked in
 * the CLI, and this section only renders when the user said yes.
 */
function mcpTelemetrySection(): string {
  return `## Telemetry

The user already agreed, during Subtext setup, that this install may log anonymous progress telemetry — step outcomes and timings, never code or data. Do not ask again. Log it with the \`telemetry-event\` MCP tool from the Subtext plugin (documented in the \`subtext-telemetry\` skill).

Log one event before Step 1 — \`workflow="onboard" step="start"\` with \`harness\` (your coding tool) and \`model\` metadata — then one event as each of Steps 1–8 completes, with an \`outcome\` (\`success\`, \`partial\`, \`fail\`, or \`skipped\`) and that step's metadata fields:

${STEP_TABLE}
${COMPLETE_ROW}

Every event's metadata may also include \`duration_ms\` (int) and \`tokens\` (int) for that step when you can estimate them. Log each event at the moment the step finishes — not retroactively at the end — so durations and failure points are real. Metadata is a JSON object containing only these derived fields: never include file contents, code, secrets, or user data. Telemetry is fire-and-forget: if the tool is unavailable (e.g. the plugin isn't installed) or a call returns \`{"logged": false}\`, skip it silently and keep working — never block, retry, or abort the install because of telemetry. Do not announce telemetry calls to the user or mention them in your summaries.`;
}

/**
 * Terminal-run variant: the agent reports progress by PRINTING marker lines to
 * stdout. The wizard (which holds the auth token) parses them out of the output
 * stream and sends the real events — the agent is never handed a credential, so
 * an install subprocess it spawns has nothing to exfiltrate. The wizard owns
 * the `start` and `complete` bookends itself, so this section covers only the
 * intermediate steps.
 */
function stdoutTelemetrySection(): string {
  return `## Telemetry

The user already agreed, during Subtext setup, that this install may log anonymous progress telemetry — step outcomes and timings, never code or data. Do not ask again, and do not run any command or make any network request for telemetry.

Instead, as each of Steps 1–7 completes, PRINT a single line to stdout in exactly this format (nothing else on the line):

\`\`\`
${TELEMETRY_MARKER_PREFIX} {"step":"<step>","outcome":"<outcome>","metadata":<metadata>}
\`\`\`

\`outcome\` is one of \`success\`, \`partial\`, \`fail\`, or \`skipped\`. The wizard reads these lines from your output and reports them; it also records the overall start and completion, so do NOT print markers for those. Use these steps and metadata fields:

${STEP_TABLE}

\`metadata\` is a compact JSON object; it may also include \`duration_ms\` (int) for that step when you can estimate it. Omit any field you don't know (use \`{}\` if none apply). Never include file contents, code, secrets, or user data. Print each marker at the moment the step finishes — not retroactively — so failure points are real. Telemetry is best-effort: if you can't determine a step's outcome, just skip its marker and keep working. Do not mention these markers in your report or summaries.`;
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
    TELEMETRY_SECTION:
      input.telemetry === 'mcp'
        ? mcpTelemetrySection()
        : input.telemetry === 'stdout'
          ? stdoutTelemetrySection()
          : '',
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
