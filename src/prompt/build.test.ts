import { describe, expect, it } from 'vitest';
import {
  AGENT_STEPS,
  METADATA_FIELDS,
  TELEMETRY_MARKER_PREFIX,
} from '../agents/telemetry-marker.js';
import { INTEGRATIONS, type IntegrationSelection } from '../integrations.js';
import {
  buildEnrichPrompt,
  buildSnippetPrompt,
  type PromptMode,
  type PromptTelemetry,
} from './build.js';

/**
 * These prompts are the whole product: everything the wizard does ends with
 * one of them being handed to an agent that auto-accepts edits. A template
 * that gains an unfilled placeholder, or a telemetry section that names a
 * step the parser will reject, breaks the install silently.
 */

const SNIPPET = `<script>\nwindow['_fs_org']='o-1G1-na1';\n</script>`;

const empty: IntegrationSelection = { integrations: [], other: [] };

const snippet = (mode: PromptMode, telemetry: PromptTelemetry = 'none') =>
  buildSnippetPrompt({ snippet: SNIPPET, mode, telemetry });

const enrich = (
  mode: PromptMode,
  telemetry: PromptTelemetry = 'none',
  selection: IntegrationSelection = empty,
) => buildEnrichPrompt({ selection, mode, telemetry });

/** Every prompt the wizard can produce, for the invariants that hold on all of them. */
const allVariants: Array<[string, string]> = [
  ['snippet/headless/none', snippet('headless')],
  ['snippet/headless/stdout', snippet('headless', 'stdout')],
  ['snippet/interactive/mcp', snippet('interactive', 'mcp')],
  ['enrich/headless/none', enrich('headless')],
  ['enrich/headless/stdout', enrich('headless', 'stdout')],
  ['enrich/interactive/mcp', enrich('interactive', 'mcp')],
];

// ---------------------------------------------------------------------------

describe('every variant', () => {
  // The one assertion that catches a template gaining a placeholder nobody
  // fills. Without it the agent is handed a literal {{PLAN_GATE}}.
  it.each(allVariants)('%s leaves no unfilled placeholder', (_name, prompt) => {
    expect(prompt).not.toMatch(/\{\{/);
  });

  it.each(allVariants)('%s collapses blank runs and ends with one newline', (_name, prompt) => {
    expect(prompt).not.toMatch(/\n{3,}/);
    expect(prompt.endsWith('\n')).toBe(true);
    expect(prompt.endsWith('\n\n')).toBe(false);
  });

  it.each(allVariants)('%s keeps the shared reference and language sections', (_name, prompt) => {
    expect(prompt).toContain('https://subtext.fullstory.com/llms.txt');
    expect(prompt).toContain('never the "Fullstory snippet."');
  });
});

describe('phase selection', () => {
  it('builds the snippet phase from the snippet steps', () => {
    const prompt = snippet('headless');
    expect(prompt).toMatch(/^Install the Subtext capture snippet/);
    expect(prompt).toContain('## Step 4: Install the snippet');
    expect(prompt).not.toContain('## Step 6: Mask sensitive data');
  });

  it('builds the enrich phase from the enrich steps', () => {
    const prompt = enrich('headless');
    expect(prompt).toMatch(/^Finish setting up Subtext/);
    expect(prompt).toContain('The capture snippet is already installed.');
    expect(prompt).toContain('## Step 6: Mask sensitive data');
    expect(prompt).not.toContain('## Step 4: Install the snippet');
  });

  it('interpolates the snippet verbatim inside the html fence', () => {
    expect(snippet('headless')).toContain('```html\n' + SNIPPET + '\n```');
  });
});

/**
 * Both headless runs write a report, and they run in the same directory. A
 * shared filename would have the enrich pass overwrite the install report
 * the outro points the user at.
 */
describe('mode section', () => {
  it('tells a headless run not to wait, and names a per-phase report file', () => {
    expect(snippet('headless')).toContain('./subtext-setup-report.md');
    expect(enrich('headless')).toContain('./subtext-enrich-report.md');
    expect(snippet('headless')).toContain('do NOT wait');
  });

  it('gives the two phases different report filenames', () => {
    expect(snippet('headless')).not.toContain('subtext-enrich-report.md');
    expect(enrich('headless')).not.toContain('subtext-setup-report.md');
  });

  it('keeps the approval gates for an interactive run, and asks for no report file', () => {
    const prompt = snippet('interactive');
    expect(prompt).toContain('## Mode: interactive');
    expect(prompt).toContain('honoring every approval gate');
    expect(prompt).not.toContain('subtext-setup-report.md');
  });
});

describe('approval gates', () => {
  it('drops the plan gate in headless and keeps it interactive', () => {
    expect(snippet('headless')).toContain('## Step 3: Present plan\n');
    expect(snippet('interactive')).toContain('## Step 3: Present plan, wait for approval');
  });

  it('swaps the plan detail for a report instruction when headless', () => {
    expect(snippet('headless')).toContain('Record this plan in your report');
    expect(snippet('interactive')).toContain('Wait for the user to approve the plan');
  });

  it('swaps the identity and privacy gates for the enrich phase', () => {
    expect(enrich('headless')).toContain('record the call site and values in your report');
    expect(enrich('interactive')).toContain('Wait for confirmation, then insert');
    expect(enrich('headless')).toContain('record the file, line, and the class you added');
    expect(enrich('interactive')).toContain('Wait for the user to confirm before writing');
  });

  it('swaps the explain verb', () => {
    expect(snippet('headless')).toContain('include this in your report');
    expect(snippet('interactive')).toContain('tell the user');
  });
});

// ---------------------------------------------------------------------------

describe('telemetry section', () => {
  it('is absent entirely when telemetry is off', () => {
    expect(snippet('headless', 'none')).not.toContain('## Telemetry');
    expect(enrich('headless', 'none')).not.toContain('## Telemetry');
  });

  describe('stdout transport', () => {
    it('names the marker prefix and forbids network calls for telemetry', () => {
      const prompt = snippet('headless', 'stdout');
      expect(prompt).toContain(TELEMETRY_MARKER_PREFIX);
      expect(prompt).toContain('do not run any command or make any network request');
      expect(prompt).not.toContain('telemetry-event');
    });

    // The wizard owns the bookends; a marker for either is rejected by the
    // parser, so the prompt must never ask for one.
    it('never asks the agent to report start or complete', () => {
      const prompt = snippet('headless', 'stdout');
      expect(prompt).not.toContain('| `start` |');
      expect(prompt).not.toContain('| `complete` |');
      expect(prompt).toContain('do NOT print markers for those');
    });

    it('lists only the phase’s own steps', () => {
      expect(tableSteps(snippet('headless', 'stdout'))).toEqual([
        'precheck',
        'explore',
        'plan',
        'install',
      ]);
      expect(tableSteps(enrich('headless', 'stdout'))).toEqual([
        'identify',
        'link_analytics',
        'mask_pii',
      ]);
    });
  });

  describe('mcp transport', () => {
    it('points at the plugin tool rather than stdout markers', () => {
      const prompt = snippet('interactive', 'mcp');
      expect(prompt).toContain('`telemetry-event` MCP tool');
      expect(prompt).not.toContain(TELEMETRY_MARKER_PREFIX);
    });

    it('does not re-ask for consent — the wizard already did', () => {
      expect(snippet('interactive', 'mcp')).toContain('Do not ask again');
    });

    /**
     * An MCP handoff is a single run, so the snippet phase is where it ends
     * and the agent owns `complete`. The enrich phase is never driven over
     * MCP (it's a copyable follow-up with telemetry off), so it must not
     * claim the bookend.
     */
    it('gives the agent the complete row only for the snippet phase', () => {
      expect(snippet('interactive', 'mcp')).toContain('| Final | `complete` |');
      expect(enrich('interactive', 'mcp')).not.toContain('| Final |');
    });

    it('asks for a start event, which the stdout transport does not', () => {
      expect(snippet('interactive', 'mcp')).toContain('step="start"');
      expect(snippet('headless', 'stdout')).not.toContain('step="start"');
    });
  });
});

/**
 * The prompt tells the agent which steps and metadata fields to emit; the
 * marker parser decides which ones survive. Nothing links the two lists, and
 * the comments in both files ask for exactly this check — a field added on
 * one side alone is dropped silently and the funnel just loses it.
 */
describe('stdout prompt matches what the marker parser accepts', () => {
  const phases = [
    ['snippet', snippet('headless', 'stdout')],
    ['enrich', enrich('headless', 'stdout')],
  ] as const;

  it.each(phases)('every step the %s prompt names is an accepted step', (_phase, prompt) => {
    const steps = tableSteps(prompt);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(AGENT_STEPS.has(step), `parser rejects step "${step}"`).toBe(true);
    }
  });

  it.each(phases)('every field the %s prompt names survives sanitization', (_phase, prompt) => {
    const fields = tableFields(prompt);
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field in METADATA_FIELDS, `parser drops metadata field "${field}"`).toBe(true);
    }
  });

  it('documents duration_ms, which the parser also allows', () => {
    expect(snippet('headless', 'stdout')).toContain('`duration_ms` (int)');
    expect(METADATA_FIELDS.duration_ms).toBe('number');
  });
});

// ---------------------------------------------------------------------------

describe('integrations section', () => {
  it('tells the agent to detect for itself when nothing was named', () => {
    const prompt = enrich('headless', 'none', empty);
    expect(prompt).toContain('The user did not name any analytics or product tools');
    expect(prompt).toContain('your own search of `package.json`');
  });

  it('is omitted from the snippet phase, which never asks', () => {
    expect(snippet('headless')).not.toContain('## Target integrations');
  });

  it('lists a named tool with its packages and script-tag global', () => {
    const posthog = INTEGRATIONS.find((i) => i.id === 'posthog')!;
    const prompt = enrich('headless', 'none', { integrations: [posthog], other: [] });

    expect(prompt).toContain('**PostHog**');
    expect(prompt).toContain('`posthog-js`');
    expect(prompt).toContain('`window.posthog` global');
  });

  it('omits the global hint for a tool that has no script-tag install', () => {
    const statsig = INTEGRATIONS.find((i) => i.id === 'statsig')!;
    const prompt = enrich('headless', 'none', { integrations: [statsig], other: [] });

    expect(prompt).toContain('**Statsig**');
    expect(prompt).not.toMatch(/\*\*Statsig\*\*[^\n]*window\./);
  });

  it('gives a free-text tool the generic find-its-SDK instruction', () => {
    const prompt = enrich('headless', 'none', { integrations: [], other: ['Heap'] });
    expect(prompt).toContain('**Heap** — the user named this tool themselves');
    expect(prompt).toContain('`subtext_url`');
  });
});

describe('linkage examples', () => {
  it('falls back to a generic example when nothing was selected', () => {
    expect(enrich('headless')).toContain('// Generic example');
  });

  it('uses each selected tool’s own call', () => {
    const [posthog, sentry] = ['posthog', 'sentry'].map(
      (id) => INTEGRATIONS.find((i) => i.id === id)!,
    );
    const prompt = enrich('headless', 'none', { integrations: [posthog, sentry], other: [] });

    expect(prompt).toContain('posthog.identify(user.id, { subtext_url: subtextUrl });');
    expect(prompt).toContain("Sentry.setTag('subtext_url', subtextUrl);");
    expect(prompt).not.toContain('// Generic example');
  });

  // The examples land inside a fenced block nested in a numbered list, so a
  // lost indent breaks the fence and the code leaks into the prose.
  it('indents every example line to sit inside the template fence', () => {
    const posthog = INTEGRATIONS.find((i) => i.id === 'posthog')!;
    const prompt = enrich('headless', 'none', { integrations: [posthog], other: [] });

    expect(prompt).toContain('   // PostHog');
    expect(prompt).toContain('   posthog.identify');
  });
});

// ---------------------------------------------------------------------------
// Parsing helpers for the generated telemetry table.

/** The `step` cell of each data row, skipping the header and the Final row. */
function tableSteps(prompt: string): string[] {
  return tableRows(prompt)
    .filter((cells) => cells[0] !== 'Final')
    .map((cells) => cells[1].replace(/`/g, '').trim());
}

/** Every backticked metadata field name across the table's third column. */
function tableFields(prompt: string): string[] {
  return tableRows(prompt).flatMap((cells) =>
    [...cells[2].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]),
  );
}

function tableRows(prompt: string): string[][] {
  return prompt
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length === 3 && cells[0] !== 'After' && !cells[0].startsWith('---'));
}
