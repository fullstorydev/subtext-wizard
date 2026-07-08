import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runTerminalAgent } from './agents/helpers.js';
import { MANUAL_CHOICE } from './agents/index.js';
import type { DetectedAgent } from './agents/types.js';
import type { Region, WizardOptions } from './config.js';
import { subtextMcpUrl } from './config.js';

/**
 * Post-install plugin setup. Once the coding agent has run (or been handed)
 * the install prompt, wire Subtext into that same harness so it can review
 * captured sessions in later conversations.
 *
 * The packaged plugin is preferred wherever one exists, because it bundles
 * the skills (proof, review, live…) on top of the MCP server: Claude Code
 * installs it via its plugin CLI, Cursor via the official /add-plugin.
 * Harnesses without a plugin get the raw MCP server entry written straight
 * into their own config file — tools only, no agent commands involved.
 * Harnesses without a file we can safely edit (Zed, Claude Desktop,
 * unknown) get instructions instead, as do declines and unparseable
 * configs.
 */

export const PLUGIN_MARKETPLACE_URL = 'https://github.com/fullstorydev/subtext';
export const PLUGIN_SPEC = 'subtext@subtext-marketplace';

const WHY_PLUGIN =
  'The Subtext plugin gives your coding agent tools and skills to replay and review the sessions you just set up capturing.';

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
 * edit — those harnesses get instructions. Cursor is deliberately absent:
 * its packaged plugin (/add-plugin subtext) is the primary route, so it
 * goes through instructions rather than a config write.
 */
function configWrite(agentId: string, dir: string, region: Region): ConfigWrite | null {
  const url = subtextMcpUrl(region);
  const home = os.homedir();
  switch (agentId) {
    case 'claude-code':
      return jsonConfigWrite(path.join(dir, '.mcp.json'), 'mcpServers', { type: 'http', url });
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
        'In a Claude Code session, run (installs tools + skills):',
        `  /plugin marketplace add ${PLUGIN_MARKETPLACE_URL}`,
        `  /plugin install ${PLUGIN_SPEC}`,
        '',
        'Prefer a raw MCP server (tools only)? Add this to .mcp.json in the project:',
        ...indent(manualMcpConfig(region)),
      ];
    case 'cursor':
      return [
        'In Cursor, run this in the agent pane (installs tools + skills):',
        '  /add-plugin subtext',
        '',
        'Prefer a raw MCP server (tools only)? Add this to .cursor/mcp.json in the project:',
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
    'Claude Code — run in a session (installs tools + skills):',
    `  /plugin marketplace add ${PLUGIN_MARKETPLACE_URL}`,
    `  /plugin install ${PLUGIN_SPEC}`,
    '',
    'Cursor — run in the agent pane (installs tools + skills):',
    '  /add-plugin subtext',
    '',
    'Any other MCP-capable agent — add this server config (tools only):',
    ...indent(manualMcpConfig(region)),
  ];
}

// ---------------------------------------------------------------------------
// The wizard step
// ---------------------------------------------------------------------------

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
 * Claude Code path: the packaged plugin first — it carries the skills, not
 * just the MCP tools — and the raw .mcp.json entry only if that fails.
 */
async function claudeCodePluginSetup(
  chosen: DetectedAgent,
  options: WizardOptions,
  onEvent: (event: string, properties?: Record<string, unknown>) => void,
): Promise<void> {
  let install = true;
  if (!options.agent) {
    const answer = await p.confirm({
      message: `Install the Subtext plugin in Claude Code? ${pc.dim(
        '(session-review tools plus the proof/review skills)',
      )}`,
    });
    install = !p.isCancel(answer) && answer;
  }
  if (!install) {
    onEvent('plugin_setup_declined', { agent: 'claude-code' });
    p.note(pluginInstructions('claude-code', options.region).join('\n'), 'Install it later');
    return;
  }

  if (options.mock) {
    p.log.info(pc.dim('Mock mode: skipping the real plugin install.'));
    onEvent('plugin_setup_completed', { agent: 'claude-code', method: 'mock' });
    return;
  }

  p.log.step('Installing the Subtext plugin in Claude Code…');
  let installed = false;
  try {
    installed = await installClaudeCodePlugin(chosen.binaryPath!, options.dir);
  } catch {
    // fall through to the raw MCP server entry
  }
  if (installed) {
    onEvent('plugin_setup_completed', { agent: 'claude-code', method: 'plugin-cli' });
    p.log.success(
      'Subtext plugin installed — tools and skills are available in your next Claude Code session.',
    );
    return;
  }

  p.log.warn('Plugin install failed — falling back to a raw MCP server entry (tools only).');
  const target = configWrite('claude-code', options.dir, options.region)!;
  let outcome: WriteOutcome;
  try {
    outcome = await target.write();
  } catch {
    outcome = 'unparseable';
  }
  if (outcome === 'unparseable') {
    onEvent('plugin_setup_failed', { agent: 'claude-code' });
    p.note(pluginInstructions('claude-code', options.region).join('\n'), 'Add it by hand');
    return;
  }
  onEvent('plugin_setup_completed', { agent: 'claude-code', method: 'config-write-fallback' });
  p.log.success(
    outcome === 'written'
      ? `Subtext MCP server added to ${prettyPath(target.file)} — picked up the next time Claude Code starts here.`
      : `Subtext MCP server already configured in ${prettyPath(target.file)}.`,
  );
}

/**
 * Step 8 of the wizard, after the prompt run: wire Subtext into the harness
 * that ran the install — packaged plugin where one exists, raw MCP server
 * entry otherwise. Never throws — the install already succeeded, so plugin
 * trouble is reported and the wizard finishes cleanly.
 */
export async function offerPluginSetup(
  chosen: DetectedAgent | typeof MANUAL_CHOICE,
  options: WizardOptions,
  onEvent: (event: string, properties?: Record<string, unknown>) => void,
): Promise<void> {
  const agentId = chosen === MANUAL_CHOICE ? MANUAL_CHOICE : chosen.definition.id;
  onEvent('plugin_setup_offered', { agent: agentId });

  if (chosen !== MANUAL_CHOICE && agentId === 'claude-code' && chosen.binaryPath) {
    await claudeCodePluginSetup(chosen, options, onEvent);
    return;
  }

  const target = configWrite(agentId, options.dir, options.region);
  if (!target) {
    // Cursor (plugin route), Zed, Claude Desktop, manual.
    const lines =
      chosen === MANUAL_CHOICE
        ? manualChoiceInstructions(options.region)
        : pluginInstructions(agentId, options.region);
    onEvent('plugin_setup_completed', { agent: agentId, method: 'instructions' });
    p.note([WHY_PLUGIN, '', ...lines].join('\n'), 'Add the Subtext plugin');
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
