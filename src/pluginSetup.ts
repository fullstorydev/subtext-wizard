import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runTerminalAgent } from './agents/helpers.js';
import { MANUAL_CHOICE } from './agents/index.js';
import type { DetectedAgent } from './agents/types.js';
import type { Region, WizardOptions } from './config.js';
import { subtextMcpUrl } from './plugin.js';

/**
 * Post-install plugin setup. Once the coding agent has run (or been handed)
 * the install prompt, wire Subtext into that same harness so it can review
 * captured sessions in later conversations.
 *
 * The packaged plugin is preferred wherever one exists, because it bundles
 * more than the MCP server (skills for Claude Code, both realm servers for
 * Gemini): Claude Code and Gemini CLI install it via their own CLIs, Cursor
 * via the official /add-plugin. Harnesses without a plugin get the raw MCP
 * server entry written straight into their own config file — tools only,
 * no agent commands involved. Harnesses without a file we can safely edit
 * (Zed, Claude Desktop, unknown) get instructions instead, as do declines
 * and unparseable configs.
 */

/** The plugin repo: Claude Code marketplace and Gemini extension
 * (gemini-extension.json) in one. */
export const PLUGIN_REPO_URL = 'https://github.com/fullstorydev/subtext';
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
  if (file === home) return '~';
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

// ---------------------------------------------------------------------------
// Direct config writes
// ---------------------------------------------------------------------------

type WriteOutcome = 'written' | 'unchanged' | 'unparseable';

interface ConfigWrite {
  /** Config file the server entry goes into. */
  file: string;
  write(): Promise<WriteOutcome>;
  /** Remove a subtext entry this wizard previously wrote — recognized by
   * its URL pointing at one of our realm endpoints, so a user's custom
   * entry is left alone. Used when a packaged plugin supersedes a raw
   * fallback entry from an earlier run. Returns whether it removed one. */
  removeOurs?(): Promise<boolean>;
}

/** Both realm endpoints — used to recognize entries we wrote. */
function subtextUrls(): string[] {
  return [subtextMcpUrl('us'), subtextMcpUrl('eu')];
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge `{ [section]: { subtext: entry } }` into a JSON config file,
 * creating the file (and parent dirs) if needed. Never clobbers a file it
 * can't parse or merge into — JSONC configs with comments, or files where
 * the root or section isn't an object, fall back to instructions.
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
        const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!isPlainObject(parsed)) return 'unparseable';
        config = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unparseable';
      }
      if (config[section] != null && !isPlainObject(config[section])) return 'unparseable';
      const servers = (config[section] ??= {}) as JsonObject;
      // Merge on top of an existing entry so user extras (headers, disabled,
      // timeouts…) survive a re-run, but drop competing transport fields we
      // aren't setting — e.g. a deprecated httpUrl next to the new url.
      const merged: JsonObject = {
        ...(isPlainObject(servers.subtext) ? servers.subtext : {}),
        ...entry,
      };
      for (const key of ['url', 'httpUrl', 'serverUrl', 'type', 'transport', 'command', 'args']) {
        if (!(key in entry)) delete merged[key];
      }
      if (JSON.stringify(servers.subtext) === JSON.stringify(merged)) return 'unchanged';
      servers.subtext = merged;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      return 'written';
    },
    async removeOurs() {
      let config: JsonObject;
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!isPlainObject(parsed)) return false;
        config = parsed;
      } catch {
        return false;
      }
      const servers = config[section];
      if (!isPlainObject(servers) || !isPlainObject(servers.subtext)) return false;
      const { url, httpUrl, serverUrl } = servers.subtext;
      const endpoint = [url, httpUrl, serverUrl].find(
        (v): v is string => typeof v === 'string',
      );
      if (!endpoint || !subtextUrls().includes(endpoint)) return false;
      delete servers.subtext;
      await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      return true;
    },
  };
}

/**
 * Codex config is TOML, which we don't parse — append the server table if
 * it isn't there yet. When the table already exists, rewrite just its
 * `url` line so a realm change on a re-run doesn't leave a stale host;
 * a table we can't find the url in falls back to instructions.
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
      // Line-anchored so the header inside a comment or string doesn't
      // count; tolerates CRLF line endings.
      const headerRe = /^[ \t]*\[mcp_servers\.subtext\][ \t]*(?:#.*)?\r?$/m;
      const headerMatch = headerRe.exec(existing);
      if (headerMatch) {
        const tableStart = headerMatch.index + headerMatch[0].length;
        const nextTableRe = /\n[ \t]*\[/g;
        nextTableRe.lastIndex = tableStart;
        const nextTable = nextTableRe.exec(existing);
        const tableEnd = nextTable ? nextTable.index : existing.length;
        const table = existing.slice(tableStart, tableEnd);
        const urlLine = /^(\s*url\s*=\s*)"[^"]*"/m;
        if (!urlLine.test(table)) return 'unparseable';
        const updated = table.replace(urlLine, (_, prefix: string) => `${prefix}"${url}"`);
        if (updated === table) return 'unchanged';
        await fs.writeFile(
          file,
          existing.slice(0, tableStart) + updated + existing.slice(tableEnd),
          'utf8',
        );
        return 'written';
      }
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
 * goes through instructions rather than a config write. Claude Code and
 * Gemini entries are the fallbacks behind their packaged plugin installs.
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
      // `url` + explicit `type` is the consolidated schema (the old
      // `httpUrl` field is deprecated, kept only as a compat fallback).
      return jsonConfigWrite(path.join(home, '.gemini', 'settings.json'), 'mcpServers', {
        url,
        type: 'http',
      });
    case 'windsurf':
      // Cascade reads ~/.codeium/windsurf/mcp_config.json.
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

/** Harness-specific instructions for adding the plugin/server by hand. */
function pluginInstructions(agentId: string, region: Region): string[] {
  const url = subtextMcpUrl(region);
  switch (agentId) {
    case 'claude-code':
      return [
        'In a Claude Code session, run (installs tools + skills):',
        `  /plugin marketplace add ${PLUGIN_REPO_URL}`,
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
    case 'gemini':
      return [
        'Install the Subtext extension (bundles the MCP servers):',
        `  gemini extensions install ${PLUGIN_REPO_URL}`,
        '',
        'Prefer a raw MCP server? Add this to ~/.gemini/settings.json:',
        ...indent(JSON.stringify({ mcpServers: { subtext: { url, type: 'http' } } }, null, 2)),
      ];
    case 'windsurf':
      return [
        'Add this to ~/.codeium/windsurf/mcp_config.json (read by Cascade in Windsurf):',
        ...indent(JSON.stringify({ mcpServers: { subtext: { serverUrl: url } } }, null, 2)),
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
    `  /plugin marketplace add ${PLUGIN_REPO_URL}`,
    `  /plugin install ${PLUGIN_SPEC}`,
    '',
    'Cursor — run in the agent pane (installs tools + skills):',
    '  /add-plugin subtext',
    '',
    'Gemini CLI — install the extension:',
    `  gemini extensions install ${PLUGIN_REPO_URL}`,
    '',
    'Any other MCP-capable agent — add this server config (tools only):',
    ...indent(manualMcpConfig(region)),
  ];
}

// ---------------------------------------------------------------------------
// Packaged plugin installs
// ---------------------------------------------------------------------------

/**
 * Run `claude plugin marketplace add` + `claude plugin install`. The
 * marketplace add is soft-fail (it errors when the marketplace is already
 * registered, e.g. on a re-run); the install itself decides success.
 */
async function installClaudeCodePlugin(binaryPath: string, cwd: string): Promise<boolean> {
  const addExit = await runTerminalAgent({
    binaryPath,
    args: ['plugin', 'marketplace', 'add', PLUGIN_REPO_URL],
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

interface PackagedPlugin {
  /** Confirm-prompt fragment describing what the install brings. */
  confirmHint: string;
  /** The commands install() runs, for mock-mode display. */
  commands: string[];
  /** Fast local check for an existing install, so re-runs don't fall back
   * into writing a duplicate raw server entry. */
  alreadyInstalled(): Promise<boolean>;
  install(): Promise<boolean>;
}

/** The scriptable plugin install for this harness, if it has one. */
function packagedPlugin(chosen: DetectedAgent, options: WizardOptions): PackagedPlugin | null {
  const { binaryPath } = chosen;
  if (!binaryPath) return null;
  switch (chosen.definition.id) {
    case 'claude-code':
      return {
        confirmHint: 'session-review tools plus the proof/review skills',
        commands: [
          `claude plugin marketplace add ${PLUGIN_REPO_URL}`,
          `claude plugin install ${PLUGIN_SPEC}`,
        ],
        // `claude plugin install` records installs in installed_plugins.json,
        // keyed by <plugin>@<marketplace> — the same spec we install. A
        // user-scoped install applies everywhere; project/local ones only
        // count when they're for the directory being instrumented.
        alreadyInstalled: async () => {
          try {
            const installed = JSON.parse(
              await fs.readFile(
                path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'),
                'utf8',
              ),
            ) as { plugins?: Record<string, unknown> };
            const entries = installed.plugins?.[PLUGIN_SPEC];
            if (!Array.isArray(entries)) return false;
            return entries.some(
              (entry) =>
                isPlainObject(entry) &&
                (entry.scope === 'user' ||
                  (typeof entry.projectPath === 'string' &&
                    path.resolve(entry.projectPath) === path.resolve(options.dir))),
            );
          } catch {
            return false;
          }
        },
        install: () => installClaudeCodePlugin(binaryPath, options.dir),
      };
    case 'gemini':
      return {
        confirmHint: 'installs the Subtext extension with its MCP servers',
        commands: [`gemini extensions install ${PLUGIN_REPO_URL}`],
        alreadyInstalled: async () => {
          try {
            await fs.access(path.join(os.homedir(), '.gemini', 'extensions', 'subtext'));
            return true;
          } catch {
            return false;
          }
        },
        install: async () =>
          (await runTerminalAgent({
            binaryPath,
            args: ['extensions', 'install', PLUGIN_REPO_URL],
            cwd: options.dir,
            stdout: 'inherit',
          })) === 0,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The wizard step
// ---------------------------------------------------------------------------

/** Write the raw server entry and report; instructions if the file resists. */
async function applyConfigWrite(
  target: ConfigWrite,
  agentId: string,
  agentName: string,
  region: Region,
  onEvent: (event: string, properties?: Record<string, unknown>) => void,
  method: string,
): Promise<void> {
  const shownPath = prettyPath(target.file);
  let outcome: WriteOutcome;
  try {
    outcome = await target.write();
  } catch {
    outcome = 'unparseable';
  }
  if (outcome === 'unparseable') {
    onEvent('plugin_setup_failed', { agent: agentId });
    p.log.warn(`Could not update ${shownPath} — it may have a format we can't merge safely.`);
    p.note(pluginInstructions(agentId, region).join('\n'), 'Add it by hand');
    return;
  }
  onEvent('plugin_setup_completed', { agent: agentId, method });
  p.log.success(
    outcome === 'written'
      ? `Subtext MCP server added to ${shownPath} — picked up the next time ${agentName} starts here.`
      : `Subtext MCP server already configured in ${shownPath}.`,
  );
}

/**
 * A working packaged plugin supersedes any raw fallback entry left by an
 * earlier run — drop it so the harness doesn't load Subtext twice.
 * Best-effort: only removes an entry whose URL is one of our endpoints.
 */
async function removeSupersededRawEntry(
  agentId: string,
  dir: string,
  region: Region,
): Promise<void> {
  const target = configWrite(agentId, dir, region);
  if (!target?.removeOurs) return;
  try {
    if (await target.removeOurs()) {
      p.log.info(
        pc.dim(
          `Removed the raw MCP server entry from ${prettyPath(target.file)} — the plugin supersedes it.`,
        ),
      );
    }
  } catch {
    // duplicate tools are annoying but not worth failing the step over
  }
}

/**
 * Confirm gate for the plugin prompts. An explicit "No" is a decline —
 * instructions for later. Ctrl+C / Escape skips the rest of the step
 * with no further output: unlike the wizard's earlier prompts this is
 * not a CancelledError, because by now the install itself has already
 * succeeded and "nothing was changed" / exit 130 would misreport it.
 */
async function confirmOrSkip(
  message: string,
  agentId: string,
  region: Region,
  onEvent: (event: string, properties?: Record<string, unknown>) => void,
  laterTitle: string,
): Promise<boolean> {
  const answer = await p.confirm({ message });
  if (p.isCancel(answer)) {
    onEvent('plugin_setup_declined', { agent: agentId, cancelled: true });
    p.log.info(
      pc.dim('Plugin setup skipped — run this installer again any time to set it up.'),
    );
    return false;
  }
  if (!answer) {
    onEvent('plugin_setup_declined', { agent: agentId });
    p.note(pluginInstructions(agentId, region).join('\n'), laterTitle);
    return false;
  }
  return true;
}

/** Packaged plugin path: install via the harness's own CLI, raw entry on failure. */
async function packagedPluginSetup(
  plugin: PackagedPlugin,
  chosen: DetectedAgent,
  region: Region,
  options: WizardOptions,
  onEvent: (event: string, properties?: Record<string, unknown>) => void,
): Promise<void> {
  const agentId = chosen.definition.id;
  const agentName = chosen.definition.name;

  // Check for an existing install before asking anything — a re-run
  // shouldn't prompt for (or count a decline against) a plugin that's
  // already there. Skipped in mock mode, which never reads real state.
  if (!options.mock && (await plugin.alreadyInstalled())) {
    await removeSupersededRawEntry(agentId, options.dir, region);
    onEvent('plugin_setup_completed', { agent: agentId, method: 'already-installed' });
    p.log.success(`Subtext plugin already installed in ${agentName}.`);
    return;
  }

  // A pre-selected --agent means "just run it", same as the prompt-review
  // bypass; otherwise ask before touching the user's harness config.
  if (
    !options.agent &&
    !(await confirmOrSkip(
      `Install the Subtext plugin in ${agentName}? ${pc.dim(`(${plugin.confirmHint})`)}`,
      agentId,
      region,
      onEvent,
      'Install it later',
    ))
  ) {
    return;
  }

  if (options.mock) {
    p.log.info(
      pc.dim(`Mock mode: would run\n  ${plugin.commands.join('\n  ')}`),
    );
    onEvent('plugin_setup_completed', { agent: agentId, method: 'mock' });
    return;
  }

  p.log.step(`Installing the Subtext plugin in ${agentName}…`);
  let installed = false;
  try {
    installed = await plugin.install();
  } catch {
    // fall through to the raw MCP server entry
  }
  if (installed) {
    await removeSupersededRawEntry(agentId, options.dir, region);
    onEvent('plugin_setup_completed', { agent: agentId, method: 'plugin-cli' });
    p.log.success(
      `Subtext plugin installed — available in your next ${agentName} session.`,
    );
    return;
  }

  p.log.warn('Plugin install failed — a raw MCP server entry (tools only) can be added instead.');
  const target = configWrite(agentId, options.dir, region)!;
  // The user approved the plugin install, not a config-file edit — ask
  // again before touching a different file (same --agent bypass as above).
  if (
    !options.agent &&
    !(await confirmOrSkip(
      `Add the Subtext MCP server to ${prettyPath(target.file)} instead?`,
      agentId,
      region,
      onEvent,
      'Add it later',
    ))
  ) {
    return;
  }
  await applyConfigWrite(target, agentId, agentName, region, onEvent, 'config-write-fallback');
}

/**
 * Step 8 of the wizard, after the prompt run: wire Subtext into the harness
 * that ran the install — packaged plugin where one exists, raw MCP server
 * entry otherwise. `region` is the org's resolved realm (from the auth
 * token), not the CLI flag — the MCP URLs written here must match the org.
 * Never throws — the install already succeeded, so plugin trouble is
 * reported and the wizard finishes cleanly.
 */
export async function offerPluginSetup(
  chosen: DetectedAgent | typeof MANUAL_CHOICE,
  region: Region,
  options: WizardOptions,
  onEvent: (event: string, properties?: Record<string, unknown>) => void,
): Promise<void> {
  const agentId = chosen === MANUAL_CHOICE ? MANUAL_CHOICE : chosen.definition.id;
  onEvent('plugin_setup_offered', { agent: agentId });

  if (chosen !== MANUAL_CHOICE) {
    const plugin = packagedPlugin(chosen, options);
    if (plugin) {
      await packagedPluginSetup(plugin, chosen, region, options, onEvent);
      return;
    }
  }

  const target = chosen === MANUAL_CHOICE ? null : configWrite(agentId, options.dir, region);
  if (!target) {
    // Cursor (plugin route), Zed, Claude Desktop, manual.
    const lines =
      chosen === MANUAL_CHOICE
        ? manualChoiceInstructions(region)
        : pluginInstructions(agentId, region);
    onEvent('plugin_setup_completed', { agent: agentId, method: 'instructions' });
    p.note([WHY_PLUGIN, '', ...lines].join('\n'), 'Add the Subtext plugin');
    return;
  }

  const agentName = chosen === MANUAL_CHOICE ? 'your agent' : chosen.definition.name;
  const shownPath = prettyPath(target.file);

  if (
    !options.agent &&
    !(await confirmOrSkip(
      `Add the Subtext MCP server to ${shownPath}? ${pc.dim(
        `(lets ${agentName} review captured sessions)`,
      )}`,
      agentId,
      region,
      onEvent,
      'Add it later',
    ))
  ) {
    return;
  }

  if (options.mock) {
    p.log.info(pc.dim(`Mock mode: would add the Subtext MCP server to ${shownPath}.`));
    onEvent('plugin_setup_completed', { agent: agentId, method: 'mock' });
    return;
  }

  await applyConfigWrite(target, agentId, agentName, region, onEvent, 'config-write');
}
