import fs from 'node:fs';
import type { IntegrationSelection } from '../integrations.js';
import { packageRootPath } from '../paths.js';

export type PromptMode = 'headless' | 'interactive';

/**
 * How the prompt instructs the agent to report telemetry:
 * - 'curl'  — headless terminal runs; the wizard hands the agent an auth
 *   token via env and it POSTs WorkflowEvents directly.
 * - 'mcp'   — GUI handoffs, where the wizard just guided the Subtext plugin
 *   setup; the agent logs through the `telemetry-event` MCP tool.
 * - 'none'  — telemetry declined/disabled, or an unknown agent (manual
 *   handoff) with no safe way to authenticate.
 */
export type PromptTelemetry = 'curl' | 'mcp' | 'none';

export interface BuildPromptInput {
  /** Org-specific capture snippet HTML fetched from the API. */
  snippet: string;
  selection: IntegrationSelection;
  mode: PromptMode;
  telemetry: PromptTelemetry;
  /** Realm-aware /subtext/telemetry endpoint the curl checkpoints POST to. */
  telemetryUrl: string;
}

const HEADLESS_MODE_SECTION = `## Mode: autonomous (headless)

You are running non-interactively inside the Subtext setup CLI. The user cannot answer questions mid-run. Wherever this document says to present a plan, wait for approval, or confirm before writing: do NOT wait — apply your best judgment, keep every change minimal and reviewable, and record what you did (plus anything you would have asked) in a final report written to \`./subtext-setup-report.md\`. If a step is impossible without user input, skip it and explain why in the report.`;

const INTERACTIVE_MODE_SECTION = `## Mode: interactive

Work through the steps with the user in this conversation, honoring every approval gate below.`;

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

| After | Log step | Extra metadata |
|-------|----------|----------------|
| Step 1 | \`precheck\` | \`already_installed\` (bool) |
| Step 2 | \`explore\` | \`framework\` (string), \`csp_present\` (bool) |
| Step 3 | \`plan\` | \`approved\` (bool) |
| Step 4 | \`install\` | \`framework\` (string), \`csp_modified\` (bool) |
| Step 5 | \`identify\` | \`identity_added\` (bool) |
| Step 6 | \`link_analytics\` | \`analytics_providers\` (string[] — names of every analytics/session-replay/error-monitoring/feature-flag SDK found) |
| Step 7 | \`mask_pii\` | \`masked_count\` (int), \`privacy_check\` (bool) |
| Step 8 | \`complete\` | \`total_duration_ms\` (int), \`total_tokens\` (int) |

Every event's metadata may also include \`duration_ms\` (int) and \`tokens\` (int) for that step when you can estimate them. Log each event at the moment the step finishes — not retroactively at the end — so durations and failure points are real. Metadata is a JSON object containing only these derived fields: never include file contents, code, secrets, or user data. Telemetry is fire-and-forget: if the tool is unavailable (e.g. the plugin isn't installed) or a call returns \`{"logged": false}\`, skip it silently and keep working — never block, retry, or abort the install because of telemetry. Do not announce telemetry calls to the user or mention them in your summaries.`;
}

function curlTelemetrySection(telemetryUrl: string): string {
  return `## Telemetry checkpoints

As you finish each step below, fire a non-blocking background telemetry ping so setup progress is visible to the Subtext team. The \`SUBTEXT_TELEMETRY_TOKEN\` environment variable is already set in your environment:

\`\`\`sh
curl -s -X POST '${telemetryUrl}' \\
  -H "Authorization: Bearer $SUBTEXT_TELEMETRY_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{"workflow":"onboard","step":"<step>","outcome":"<outcome>","metadata":<metadata>}' \\
  > /dev/null 2>&1 &
\`\`\`

Fire one after each of Steps 1–8, with \`step\` and \`metadata\` per this table. \`outcome\` is \`success\`, \`partial\`, \`fail\`, or \`skipped\`, describing how that step went. In \`metadata\`, omit any field you don't know, and always include \`"duration_ms"\` (wall-clock milliseconds you spent on the step) when you can estimate it.

| After  | \`step\` | \`metadata\` fields |
|--------|----------|--------------------|
| Step 1 | \`precheck\` | \`"already_installed"\` (bool) |
| Step 2 | \`explore\` | \`"framework"\` (e.g. "next"), \`"csp_present"\` (bool) |
| Step 3 | \`plan\` | \`"approved"\` (bool) |
| Step 4 | \`install\` | \`"framework"\` (e.g. "next"), \`"csp_modified"\` (bool) |
| Step 5 | \`identify\` | \`"identity_added"\` (bool) |
| Step 6 | \`link_analytics\` | \`"analytics_providers"\` (array of SDK names found) |
| Step 7 | \`mask_pii\` | \`"masked_count"\` (number), \`"privacy_check"\` (bool) |
| Step 8 | \`complete\` | \`"total_duration_ms"\`, \`"total_tokens"\` (whole-flow totals) |

Telemetry must never block or delay the install — if \`curl\` is unavailable, the variable is empty, or the request fails, skip silently and move on.`;
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
      input.telemetry === 'curl'
        ? curlTelemetrySection(input.telemetryUrl)
        : input.telemetry === 'mcp'
          ? mcpTelemetrySection()
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
