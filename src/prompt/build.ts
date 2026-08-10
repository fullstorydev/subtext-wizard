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

/**
 * Setup is split into two hand-offs so the user reaches a captured session
 * (and their first agentic session review) as fast as possible:
 * - 'snippet' — install the capture snippet + CSP only. Reports the
 *   precheck/explore/plan/install steps of the funnel.
 * - 'enrich'  — the follow-up: identify users, link analytics, mask PII.
 *   Reports the identify/link_analytics/mask_pii steps. Its own
 *   precheck/explore/plan run but are NOT re-reported, so each funnel step is
 *   logged exactly once across the two runs.
 */
export type PromptPhase = 'snippet' | 'enrich';

interface SharedPromptInput {
  mode: PromptMode;
  telemetry: PromptTelemetry;
}

export interface SnippetPromptInput extends SharedPromptInput {
  /** Org-specific capture snippet HTML fetched from the API. */
  snippet: string;
}

export interface EnrichPromptInput extends SharedPromptInput {
  selection: IntegrationSelection;
}

const TITLE_LINE: Record<PromptPhase, string> = {
  snippet: 'Install the Subtext capture snippet into my application so sessions can be captured.',
  enrich:
    'Finish setting up Subtext in my application: identify users, link the session URL into my analytics tools, and mask sensitive data. The capture snippet is already installed.',
};

const HEADLESS_MODE_SECTION = `## Mode: autonomous (headless)

You are running non-interactively inside the Subtext setup CLI. The user cannot answer questions mid-run. Wherever this document says to present a plan, wait for approval, or confirm before writing: do NOT wait — apply your best judgment, keep every change minimal and reviewable, and record what you did (plus anything you would have asked) in a final report written to \`./subtext-setup-report.md\`. If a step is impossible without user input, skip it and explain why in the report.`;

const INTERACTIVE_MODE_SECTION = `## Mode: interactive

Work through the steps with the user in this conversation, honoring every approval gate below.`;

/**
 * Single source of truth for each funnel step's `metadata` field description,
 * so the two telemetry transports (stdout markers and the MCP tool) and the
 * two phases can never drift. Keep field names in sync with
 * WorkflowEventMetadata (telemetry.ts) and the allowlist in
 * telemetry-marker.ts.
 */
const STEP_META: Record<string, string> = {
  precheck: '`already_installed` (bool)',
  explore: '`framework` (string), `csp_present` (bool)',
  plan: '`approved` (bool)',
  install: '`framework` (string), `csp_modified` (bool)',
  identify: '`identity_added` (bool)',
  link_analytics:
    '`analytics_providers` (string[] — names of every analytics/session-replay/error-monitoring/feature-flag SDK found)',
  mask_pii: '`masked_count` (int), `privacy_check` (bool)',
};

interface StepRow {
  /** The step's visible heading in the prompt, e.g. "Step 4". */
  label: string;
  /** The funnel `step` string the agent reports. */
  step: keyof typeof STEP_META | string;
}

/** Steps the snippet phase reports. */
const SNIPPET_STEPS: StepRow[] = [
  { label: 'Step 1', step: 'precheck' },
  { label: 'Step 2', step: 'explore' },
  { label: 'Step 3', step: 'plan' },
  { label: 'Step 4', step: 'install' },
];

/** Steps the enrich phase reports. Its precheck/explore/plan happen but are
 * not reported (the snippet phase already logged those funnel steps). */
const ENRICH_STEPS: StepRow[] = [
  { label: 'Step 4', step: 'identify' },
  { label: 'Step 5', step: 'link_analytics' },
  { label: 'Step 6', step: 'mask_pii' },
];

/** The MCP-only complete row (the wizard owns `complete` for terminal runs). */
const COMPLETE_ROW = '| Final | `complete` | `total_duration_ms` (int), `total_tokens` (int) |';

function stepTable(rows: StepRow[], includeComplete: boolean): string {
  const lines = [
    '| After | `step` | `metadata` fields |',
    '|-------|---------|--------------------|',
    ...rows.map((r) => `| ${r.label} | \`${r.step}\` | ${STEP_META[r.step] ?? ''} |`),
  ];
  if (includeComplete) lines.push(COMPLETE_ROW);
  return lines.join('\n');
}

/**
 * GUI-handoff variant: the agent logs milestones through the Subtext
 * plugin's `telemetry-event` MCP tool. Adapted from the settings-ui setup
 * prompt, minus the consent ask — the wizard already asked in
 * the CLI, and this section only renders when the user said yes.
 */
function mcpTelemetrySection(rows: StepRow[], includeComplete: boolean): string {
  return `## Telemetry

The user already agreed, during Subtext setup, that this install may log anonymous progress telemetry — step outcomes and timings, never code or data. Do not ask again. Log it with the \`telemetry-event\` MCP tool from the Subtext plugin (documented in the \`subtext-telemetry\` skill).

Log one event before the first step — \`workflow="onboard" step="start"\` with \`harness\` (your coding tool) and \`model\` metadata — then one event as each step listed below completes, with an \`outcome\` (\`success\`, \`partial\`, \`fail\`, or \`skipped\`) and that step's metadata fields:

${stepTable(rows, includeComplete)}

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
function stdoutTelemetrySection(rows: StepRow[]): string {
  return `## Telemetry

The user already agreed, during Subtext setup, that this install may log anonymous progress telemetry — step outcomes and timings, never code or data. Do not ask again, and do not run any command or make any network request for telemetry.

Instead, as each step listed below completes, PRINT a single line to stdout in exactly this format (nothing else on the line):

\`\`\`
${TELEMETRY_MARKER_PREFIX} {"step":"<step>","outcome":"<outcome>","metadata":<metadata>}
\`\`\`

\`outcome\` is one of \`success\`, \`partial\`, \`fail\`, or \`skipped\`. The wizard reads these lines from your output and reports them; it also records the overall start and completion, so do NOT print markers for those. Use these steps and metadata fields:

${stepTable(rows, false)}

\`metadata\` is a compact JSON object; it may also include \`duration_ms\` (int) for that step when you can estimate it. Omit any field you don't know (use \`{}\` if none apply). Never include file contents, code, secrets, or user data. Print each marker at the moment the step finishes — not retroactively — so failure points are real. Telemetry is best-effort: if you can't determine a step's outcome, just skip its marker and keep working. Do not mention these markers in your report or summaries.`;
}

function telemetrySection(phase: PromptPhase, telemetry: PromptTelemetry): string {
  if (telemetry === 'none') return '';
  const rows = phase === 'snippet' ? SNIPPET_STEPS : ENRICH_STEPS;
  // The MCP `complete` row is owned by the agent only for the snippet phase:
  // GUI/MCP handoffs are single-run (the enrich phase is never driven over
  // MCP — it's a copyable follow-up with telemetry disabled), so the snippet
  // handoff is where such a run ends.
  if (telemetry === 'mcp') return mcpTelemetrySection(rows, phase === 'snippet');
  return stdoutTelemetrySection(rows);
}

function integrationsSection(selection: IntegrationSelection): string {
  const { integrations, other } = selection;
  if (integrations.length === 0 && other.length === 0) {
    return `## Target integrations

The user did not name any analytics or product tools. Detect whatever is present using your own search of \`package.json\` and the codebase, and link the Subtext URL into anything you find in Step 5.`;
  }

  const lines: string[] = [
    '## Target integrations',
    '',
    'During setup the user said this app uses the tools below. Prioritize these in Step 2 detection and Step 5 linkage — the user expects them to exist. Still note any other analytics SDK you happen to find.',
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

/** headless-vs-interactive approval-gate wording shared by both phases. */
function gates(headless: boolean): Record<string, string> {
  return {
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
    EXPLAIN_VERB: headless ? 'include this in your report' : 'tell the user',
  };
}

const STEP_FILES: Record<PromptPhase, string> = {
  snippet: 'install-steps-snippet.md',
  enrich: 'install-steps-enrich.md',
};

function renderPrompt(phase: PromptPhase, replacements: Record<string, string>): string {
  const shell = fs.readFileSync(packageRootPath('templates', 'install-prompt.md'), 'utf8');
  const steps = fs.readFileSync(packageRootPath('templates', STEP_FILES[phase]), 'utf8');
  // Inline the phase's step body first so its own {{...}} placeholders are
  // filled by the shared replacement pass below.
  let prompt = shell.replace('{{PHASE_STEPS}}', steps);
  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }
  // Collapse blank runs left by empty sections.
  return prompt.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Phase 1: install the capture snippet + CSP only — the fast path to a
 * captured session. Integrations are unknown here, so that section is empty. */
export function buildSnippetPrompt(input: SnippetPromptInput): string {
  const headless = input.mode === 'headless';
  return renderPrompt('snippet', {
    TITLE_LINE: TITLE_LINE.snippet,
    MODE_SECTION: headless ? HEADLESS_MODE_SECTION : INTERACTIVE_MODE_SECTION,
    TELEMETRY_SECTION: telemetrySection('snippet', input.telemetry),
    INTEGRATIONS_SECTION: '',
    SNIPPET: input.snippet,
    ...gates(headless),
  });
}

/** Phase 2: the enrichment follow-up — identify users, link analytics, mask
 * PII — driven after the user has seen their first captured session. */
export function buildEnrichPrompt(input: EnrichPromptInput): string {
  const headless = input.mode === 'headless';
  return renderPrompt('enrich', {
    TITLE_LINE: TITLE_LINE.enrich,
    MODE_SECTION: headless ? HEADLESS_MODE_SECTION : INTERACTIVE_MODE_SECTION,
    TELEMETRY_SECTION: telemetrySection('enrich', input.telemetry),
    INTEGRATIONS_SECTION: integrationsSection(input.selection),
    INTEGRATION_LINKAGE_EXAMPLES: linkageExamples(input.selection),
    ...gates(headless),
  });
}
