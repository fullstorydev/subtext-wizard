import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { MANUAL_CHOICE } from './agents/index.js';
import type { DetectedAgent } from './agents/types.js';
import type { Region, WizardOptions } from './config.js';
import { subtextMcpUrl } from './config.js';

/**
 * Post-install plugin setup. Once the coding agent has run (or been handed)
 * the install prompt, wire the Subtext MCP server into that same harness so
 * it can review captured sessions in later conversations.
 *
 * The wizard writes the server entry straight into the harness's own MCP
 * config file — no agent commands, no slash commands to paste. Harnesses
 * without a file we can safely edit (Zed, Claude Desktop, unknown) get
 * instructions instead, as do declines and unparseable configs.
 */

export const PLUGIN_MARKETPLACE_URL = 'https://github.com/fullstorydev/subtext';
export const PLUGIN_SPEC = 'subtext@subtext-marketplace';

const WHY_PLUGIN =
  'The Subtext MCP server gives your coding agent tools to replay and review the sessions you just set up capturing.';

/** The generic MCP server entry, for harnesses without a specific format. */
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

function prettyPath(file: string): string {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

// ---------------------------------------------------------------------------
// Direct config writes
// ---------------------------------------------------------------------------

type WriteOutcome = 'written' | 'unchanged' | 'unparseable';

interface ConfigWrite {
  /** Config file the server entry goes into. */
  file: string;
  write(): Promise<WriteOutcome>;
}

type JsonObject = Record<string, unknown>;

/**
 * Merge `{ [section]: { subtext: entry } }` into a JSON config file,
 * creating the file (and parent dirs) if needed. Never clobbers a file it
 * can't parse — JSONC configs with comments fall back to instructions.
 */
function jsonConfigWrite(
  file: string,
  section: string,
  entry: JsonObject,
): ConfigWrite {
  return {
    file,
    async write() {
      let config: JsonObject = {};
      try {
        config = JSON.parse(await fs.readFile(file, 'utf8')) as JsonObject;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unparseable';
      }
      const servers = (config[section] ??= {}) as JsonObject;
      if (JSON.stringify(servers.subtext) === JSON.stringify(entry)) return 'unchanged';
      servers.subtext = entry;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      return 'written';
    },
  };
}

/**
 * Codex config is TOML, which we don't parse — append the server table if
 * it isn't there yet, and leave an existing one alone.
 */
function codexConfigWrite(file: string, url: string): ConfigWrite {
  return {
    file,
    async write() {
      let existing = '';
      try {
        existing = await fs.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unparseable';
      }
      if (existing.includes('[mcp_servers.subtext]')) return 'unchanged';
      const block = `${existing && !existing.endsWith('\n') ? '\n' : ''}${
        existing ? '\n' : ''
      }[mcp_servers.subtext]\nurl = "${url}"\n`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, existing + block, 'utf8');
      return 'written';
    },
  };
}

/**
 * The MCP config file each harness reads, in its own format. Project-scoped
 * where the harness supports it (the server rides along with the repo);
 * user-global otherwise. Returns null when there's no file we can safely
 * edit — those harnesses get instructions.
 */
function configWrite(agentId: string, dir: string, region: Region): ConfigWrite | null {
  const url = subtextMcpUrl(region);
  const home = os.homedir();
  switch (agentId) {
    case 'claude-code':
      return jsonConfigWrite(path.join(dir, '.mcp.json'), 'mcpServers', { type: 'http', url });
    case 'cursor':
      return jsonConfigWrite(path.join(dir, '.cursor', 'mcp.json'), 'mcpServers', { url });
    case 'vscode':
      return jsonConfigWrite(path.join(dir, '.vscode', 'mcp.json'), 'servers', {
        type: 'http',
        url,
      });
    case 'gemini':
      return jsonConfigWrite(path.join(home, '.gemini', 'settings.json'), 'mcpServers', {
        httpUrl: url,
      });
    case 'windsurf':
      return jsonConfigWrite(
        path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
        'mcpServers',
        { serverUrl: url },
      );
    case 'codex':
      return codexConfigWrite(path.join(home, '.codex', 'config.toml'), url);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Instruction fallbacks
// ---------------------------------------------------------------------------

/** Harness-specific instructions for adding the server by hand. */
function pluginInstructions(agentId: string, region: Region): string[] {
  const url = subtextMcpUrl(region);
  switch (agentId) {
    case 'claude-code':
      return [
        `Add this to .mcp.json in the project (or run /plugin install ${PLUGIN_SPEC}`,
        `after /plugin marketplace add ${PLUGIN_MARKETPLACE_URL}):`,
        ...indent(manualMcpConfig(region)),
      ];
    case 'cursor':
      return [
        'Add this to .cursor/mcp.json in the project (or run /add-plugin subtext in Cursor):',
        ...indent(JSON.stringify({ mcpServers: { subtext: { url } } }, null, 2)),
      ];
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
      return [
        `Add an MCP server named 'subtext' in your agent's MCP settings:`,
        ...indent(manualMcpConfig(region)),
      ];
  }
}

/** Shown when the user took the raw prompt — we don't know their harness. */
function manualChoiceInstructions(region: Region): string[] {
  return [
    'Claude Code — add to .mcp.json in the project:',
    ...indent(manualMcpConfig(region)),
    '',
    'Cursor — the same entry in .cursor/mcp.json (or run /add-plugin subtext).',
    '',
    'Any other MCP-capable agent — the same server URL in its MCP settings.',
  ];
}

// ---------------------------------------------------------------------------
// The wizard step
// ---------------------------------------------------------------------------

/**
 * Step 8 of the wizard, after the prompt run: wire the Subtext MCP server
 * into the harness that ran the install. Never throws — the install already
 * succeeded, so config trouble is reported and the wizard finishes cleanly.
 */
export async function offerPluginSetup(
  chosen: DetectedAgent | typeof MANUAL_CHOICE,
  options: WizardOptions,
  onEvent: (event: string, properties?: Record<string, unknown>) => void,
): Promise<void> {
  const agentId = chosen === MANUAL_CHOICE ? MANUAL_CHOICE : chosen.definition.id;
  onEvent('plugin_setup_offered', { agent: agentId });

  const target = configWrite(agentId, options.dir, options.region);
  if (!target) {
    // Zed, Claude Desktop, manual: no file we can safely edit.
    const lines =
      chosen === MANUAL_CHOICE
        ? manualChoiceInstructions(options.region)
        : pluginInstructions(agentId, options.region);
    onEvent('plugin_setup_completed', { agent: agentId, method: 'instructions' });
    p.note([WHY_PLUGIN, '', ...lines].join('\n'), 'Add the Subtext MCP server');
    return;
  }

  const agentName = chosen === MANUAL_CHOICE ? 'your agent' : chosen.definition.name;
  const shownPath = prettyPath(target.file);

  // A pre-selected --agent means "just run it", same as the prompt-review
  // bypass; otherwise ask before touching a config file.
  let proceed = true;
  if (!options.agent) {
    const answer = await p.confirm({
      message: `Add the Subtext MCP server to ${shownPath}? ${pc.dim(
        `(lets ${agentName} review captured sessions)`,
      )}`,
    });
    proceed = !p.isCancel(answer) && answer;
  }
  if (!proceed) {
    onEvent('plugin_setup_declined', { agent: agentId });
    p.note(pluginInstructions(agentId, options.region).join('\n'), 'Add it later');
    return;
  }

  if (options.mock) {
    p.log.info(pc.dim(`Mock mode: would add the Subtext MCP server to ${shownPath}.`));
    onEvent('plugin_setup_completed', { agent: agentId, method: 'mock' });
    return;
  }

  let outcome: WriteOutcome;
  try {
    outcome = await target.write();
  } catch {
    outcome = 'unparseable';
  }

  if (outcome === 'unparseable') {
    onEvent('plugin_setup_failed', { agent: agentId });
    p.log.warn(`Could not update ${shownPath} — it may have a format we can't merge safely.`);
    p.note(pluginInstructions(agentId, options.region).join('\n'), 'Add it by hand');
    return;
  }

  onEvent('plugin_setup_completed', { agent: agentId, method: 'config-write' });
  p.log.success(
    outcome === 'written'
      ? `Subtext MCP server added to ${shownPath} — picked up the next time ${agentName} starts here.`
      : `Subtext MCP server already configured in ${shownPath}.`,
  );
}
