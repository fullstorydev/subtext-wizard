import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runTerminalAgent } from './agents/helpers.js';
import { MANUAL_CHOICE } from './agents/index.js';
import type { DetectedAgent } from './agents/types.js';
import type { Region, WizardOptions } from './config.js';
import { subtextMcpUrl } from './config.js';

/**
 * Post-install plugin setup. Once the coding agent has run (or been handed)
 * the install prompt, wire the Subtext plugin / MCP server into that same
 * harness so it can review captured sessions in later conversations.
 *
 * Claude Code is the only harness with a scriptable install (its `plugin`
 * CLI subcommand); Cursor ships an official plugin behind a slash command;
 * everything else gets its own manual MCP server config.
 */

export const PLUGIN_MARKETPLACE_URL = 'https://github.com/fullstorydev/subtext';
export const PLUGIN_SPEC = 'subtext@subtext-marketplace';

const CLAUDE_CODE_SLASH_COMMANDS = [
  `/plugin marketplace add ${PLUGIN_MARKETPLACE_URL}`,
  `/plugin install ${PLUGIN_SPEC}`,
];

const WHY_PLUGIN =
  'The Subtext plugin gives your coding agent tools to replay and review the sessions you just set up capturing.';

/** The generic MCP server entry, for harnesses without a packaged plugin. */
export function manualMcpConfig(region: Region): string {
  return JSON.stringify(
    { mcpServers: { subtext: { type: 'http', url: subtextMcpUrl(region) } } },
    null,
    2,
  );
}

function indent(block: string): string[] {
  return block.split('\n').map((line) => `  ${line}`);
}

/** Harness-specific instructions for adding the plugin by hand. */
function pluginInstructions(agentId: string, region: Region): string[] {
  const url = subtextMcpUrl(region);
  switch (agentId) {
    case 'claude-code':
      return ['In a Claude Code session, run:', ...CLAUDE_CODE_SLASH_COMMANDS.map((c) => `  ${c}`)];
    case 'cursor':
      return ['In Cursor, run this in the agent pane:', '  /add-plugin subtext'];
    case 'claude-desktop':
      return [
        'In Claude Desktop: Settings → Connectors → Add custom connector,',
        `then enter: ${url}`,
      ];
    case 'codex':
      return [
        'Add the Subtext MCP server to ~/.codex/config.toml:',
        '  [mcp_servers.subtext]',
        `  url = "${url}"`,
      ];
    case 'gemini':
      return [
        'Add the Subtext MCP server to ~/.gemini/settings.json:',
        ...indent(JSON.stringify({ mcpServers: { subtext: { httpUrl: url } } }, null, 2)),
      ];
    case 'vscode':
      return [
        'Add the Subtext MCP server to .vscode/mcp.json in this project:',
        ...indent(JSON.stringify({ servers: { subtext: { type: 'http', url } } }, null, 2)),
      ];
    default:
      // windsurf, zed, and anything we don't know: point at the harness's
      // MCP settings with the generic server entry.
      return [
        `Add an MCP server named 'subtext' in your agent's MCP settings:`,
        ...indent(manualMcpConfig(region)),
      ];
  }
}

/** Shown when the user took the raw prompt — we don't know their harness. */
function manualChoiceInstructions(region: Region): string[] {
  return [
    'Claude Code — run in a session:',
    ...CLAUDE_CODE_SLASH_COMMANDS.map((c) => `  ${c}`),
    '',
    'Cursor — run in the agent pane:',
    '  /add-plugin subtext',
    '',
    'Any other MCP-capable agent — add this server config:',
    ...indent(manualMcpConfig(region)),
  ];
}

/**
 * Run `claude plugin marketplace add` + `claude plugin install`. The
 * marketplace add is soft-fail (it errors when the marketplace is already
 * registered, e.g. on a re-run); the install itself decides success.
 */
async function installClaudeCodePlugin(binaryPath: string, cwd: string): Promise<boolean> {
  const addExit = await runTerminalAgent({
    binaryPath,
    args: ['plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE_URL],
    cwd,
    stdout: 'inherit',
  });
  if (addExit !== 0) {
    p.log.info(pc.dim('Marketplace add failed — it may already be registered; continuing.'));
  }
  const installExit = await runTerminalAgent({
    binaryPath,
    args: ['plugin', 'install', PLUGIN_SPEC],
    cwd,
    stdout: 'inherit',
  });
  return installExit === 0;
}

/**
 * Step 8 of the wizard, after the prompt run: set up the Subtext plugin in
 * the harness that ran the install. Never throws for anything short of a
 * user cancel elsewhere — the install already succeeded, so plugin trouble
 * is reported and the wizard still finishes cleanly.
 */
export async function offerPluginSetup(
  chosen: DetectedAgent | typeof MANUAL_CHOICE,
  options: WizardOptions,
  onEvent: (event: string, properties?: Record<string, unknown>) => void,
): Promise<void> {
  const agentId = chosen === MANUAL_CHOICE ? MANUAL_CHOICE : chosen.definition.id;
  onEvent('plugin_setup_offered', { agent: agentId });

  // Automated path: Claude Code has a plugin CLI we can drive directly.
  if (chosen !== MANUAL_CHOICE && chosen.definition.id === 'claude-code' && chosen.binaryPath) {
    // A pre-selected --agent means "just run it", same as the prompt-review
    // bypass; otherwise ask before touching the user's Claude Code config.
    let install = true;
    if (!options.agent) {
      const answer = await p.confirm({
        message: `Install the Subtext plugin in Claude Code? ${pc.dim(
          '(adds the subtext marketplace + plugin so it can review captured sessions)',
        )}`,
      });
      install = !p.isCancel(answer) && answer;
    }
    if (!install) {
      onEvent('plugin_setup_declined', { agent: agentId });
      p.note(pluginInstructions('claude-code', options.region).join('\n'), 'Install it later');
      return;
    }

    if (options.mock) {
      p.log.info(pc.dim('Mock mode: skipping the real plugin install.'));
      onEvent('plugin_setup_completed', { agent: agentId, method: 'mock' });
      return;
    }

    p.log.step('Installing the Subtext plugin in Claude Code…');
    try {
      if (await installClaudeCodePlugin(chosen.binaryPath, options.dir)) {
        onEvent('plugin_setup_completed', { agent: agentId, method: 'cli' });
        p.log.success('Subtext plugin installed — Claude Code can review your sessions.');
        return;
      }
    } catch {
      // fall through to the manual instructions below
    }
    onEvent('plugin_setup_failed', { agent: agentId });
    p.log.warn('Could not install the plugin automatically.');
    p.note(pluginInstructions('claude-code', options.region).join('\n'), 'Install it by hand');
    return;
  }

  // Everyone else: precise instructions for their harness.
  const lines =
    chosen === MANUAL_CHOICE
      ? manualChoiceInstructions(options.region)
      : pluginInstructions(chosen.definition.id, options.region);
  onEvent('plugin_setup_completed', { agent: agentId, method: 'instructions' });
  p.note([WHY_PLUGIN, '', ...lines].join('\n'), 'Add the Subtext plugin');
}
