import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clackStub, makeOptions } from './test/helpers.js';
import type { AgentDefinition, DetectedAgent } from './agents/types.js';
import type { Region } from './config.js';

/**
 * This is the only code in the wizard that edits files in the user's home
 * directory. It runs after the install has already succeeded, so the rules
 * are: never clobber a config it cannot parse, never remove an entry it did
 * not write, and never throw — a plugin problem must not turn a finished
 * install into a reported failure.
 *
 * Everything is driven through offerPluginSetup rather than the private
 * writers, so the decision tree and the file I/O are tested together.
 */

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const h = vi.hoisted(() => ({
  homedir: vi.fn<() => string>(),
  runTerminalAgent: vi.fn<(opts: { args: string[] }) => Promise<number>>(async () => 0),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: h.homedir }, homedir: h.homedir };
});
vi.mock('./agents/helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agents/helpers.js')>();
  return { ...actual, runTerminalAgent: h.runTerminalAgent };
});

const { MANUAL_CHOICE } = await import('./agents/index.js');
const { PLUGIN_REPO_URL, PLUGIN_SPEC, manualMcpConfig, offerPluginSetup } = await import(
  './pluginSetup.js'
);
const { guidePluginSetup, subtextMcpUrl } = await import('./plugin.js');

// ---------------------------------------------------------------------------

const US_URL = 'https://api.fullstory.com/mcp/subtext';
const EU_URL = 'https://api.eu1.fullstory.com/mcp/subtext';

let home: string;
let projectDir: string;
const onEvent = vi.fn();

function agent(id: string, name: string) {
  const definition = { id, name, kind: 'terminal' } as AgentDefinition;
  return { definition, binaryPath: `/bin/${id}` } as DetectedAgent;
}

/** Detected, but with no CLI to drive — no packaged plugin is possible. */
function agentWithoutBinary(id: string, name: string) {
  return { definition: { id, name, kind: 'terminal' } as AgentDefinition } as DetectedAgent;
}

const codex = () => agent('codex', 'Codex CLI');
const claudeCode = () => agent('claude-code', 'Claude Code');
const gemini = () => agent('gemini', 'Gemini CLI');

type Overrides = Parameters<typeof makeOptions>[0];

function run(
  chosen: DetectedAgent | typeof MANUAL_CHOICE,
  region: Region,
  overrides: Overrides,
  ...preConsent: [boolean] | []
) {
  // Spread rather than pass `undefined`: an explicit undefined argument
  // triggers offerPluginSetup's own default, which is not the same thing as
  // omitting it.
  return offerPluginSetup(
    chosen,
    region,
    makeOptions({ dir: projectDir, yes: false, ...overrides }),
    onEvent,
    ...preConsent,
  );
}

/** Consent already captured pre-handoff, as the terminal flow does. */
const setup = (chosen: DetectedAgent | typeof MANUAL_CHOICE, region: Region = 'us', overrides: Overrides = {}) =>
  run(chosen, region, overrides, true);

/** No consent captured — the step asks for itself. */
const setupAsking = (chosen: DetectedAgent | typeof MANUAL_CHOICE, region: Region = 'us', overrides: Overrides = {}) =>
  run(chosen, region, overrides);

/** Consent explicitly declined earlier in the flow. */
const setupDeclined = (chosen: DetectedAgent | typeof MANUAL_CHOICE, region: Region = 'us') =>
  run(chosen, region, {}, false);

const read = (file: string) => fs.readFileSync(file, 'utf8');
const codexConfig = () => path.join(home, '.codex', 'config.toml');
const geminiSettings = () => path.join(home, '.gemini', 'settings.json');
const mcpJson = () => path.join(projectDir, '.mcp.json');

/** Every event name emitted, with its method where there is one. */
const events = () => onEvent.mock.calls.map(([name, props]) => [name, props?.method ?? null]);

/** All text the step put on screen, for instruction assertions. */
const output = () =>
  [...clack.note.mock.calls, ...clack.log.info.mock.calls, ...clack.log.warn.mock.calls]
    .flat()
    .map(String)
    .join('\n');

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtext-plugin-'));
  home = path.join(root, 'home');
  projectDir = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(projectDir);
  h.homedir.mockReturnValue(home);
  h.runTerminalAgent.mockResolvedValue(0);
});

afterEach(() => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
  // resetAllMocks, not clearAllMocks: an unconsumed mockResolvedValueOnce
  // would otherwise be picked up by the next test.
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------

describe('MCP endpoints', () => {
  it('is realm-aware', () => {
    expect(subtextMcpUrl('us')).toBe(US_URL);
    expect(subtextMcpUrl('eu')).toBe(EU_URL);
  });

  it('renders a generic server entry for agents we cannot configure', () => {
    expect(JSON.parse(manualMcpConfig('eu'))).toEqual({
      mcpServers: { subtext: { type: 'http', url: EU_URL } },
    });
  });
});

// ---------------------------------------------------------------------------

describe('the manual path', () => {
  it('prints instructions for every harness and writes nothing', async () => {
    await setupAsking(MANUAL_CHOICE);

    expect(output()).toContain(PLUGIN_REPO_URL);
    expect(output()).toContain('/add-plugin subtext');
    expect(output()).toContain(US_URL);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(events()).toContainEqual(['plugin_setup_completed', 'instructions']);
  });

  it('gives EU orgs the EU server only', async () => {
    await setupAsking(MANUAL_CHOICE, 'eu');

    expect(output()).toContain(EU_URL);
    expect(output()).not.toContain(US_URL);
    expect(output()).toContain('EU data region');
  });
});

describe('when consent was already declined', () => {
  it('leaves instructions and touches nothing', async () => {
    await setupDeclined(codex());

    expect(events()).toContainEqual(['plugin_setup_declined', null]);
    expect(output()).toContain('[mcp_servers.subtext]');
    expect(fs.existsSync(codexConfig())).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

/**
 * Codex config is TOML, which the wizard does not parse. It appends the
 * table when absent and rewrites only the url line when present.
 */
describe('Codex (TOML, no packaged plugin)', () => {
  it('creates the config and its parent directory', async () => {
    await setup(codex());

    expect(read(codexConfig())).toBe(`[mcp_servers.subtext]\nurl = "${US_URL}"\n`);
    expect(events()).toContainEqual(['plugin_setup_completed', 'config-write']);
  });

  it('appends to an existing config without disturbing it', async () => {
    fs.mkdirSync(path.dirname(codexConfig()), { recursive: true });
    fs.writeFileSync(codexConfig(), '[mcp_servers.other]\nurl = "https://other.test"\n');

    await setup(codex());

    const written = read(codexConfig());
    expect(written).toContain('[mcp_servers.other]');
    expect(written).toContain('https://other.test');
    expect(written).toContain(`[mcp_servers.subtext]\nurl = "${US_URL}"`);
  });

  it('inserts a newline when the existing file has no trailing one', async () => {
    fs.mkdirSync(path.dirname(codexConfig()), { recursive: true });
    fs.writeFileSync(codexConfig(), '[other]\nkey = 1');

    await setup(codex());

    expect(read(codexConfig())).toContain('key = 1\n\n[mcp_servers.subtext]');
  });

  // A realm change on a re-run must not leave the old host behind.
  it('rewrites only the url line when the table already exists', async () => {
    fs.mkdirSync(path.dirname(codexConfig()), { recursive: true });
    fs.writeFileSync(
      codexConfig(),
      `[mcp_servers.subtext]\nurl = "${US_URL}"\nextra = true\n\n[other]\nkey = 1\n`,
    );

    await setup(codex(), 'eu');

    const written = read(codexConfig());
    expect(written).toContain(`url = "${EU_URL}"`);
    expect(written).not.toContain(US_URL);
    expect(written).toContain('extra = true');
    expect(written).toContain('[other]');
  });

  it('reports no change on a second identical run', async () => {
    await setup(codex());
    const first = read(codexConfig());
    vi.clearAllMocks();

    await setup(codex());

    expect(read(codexConfig())).toBe(first);
    expect(String(clack.log.success.mock.calls[0][0])).toMatch(/already configured/);
  });

  /**
   * A table we cannot find a url line in is one we do not understand. Falling
   * back to instructions is right; rewriting it would risk the user's config.
   */
  it('refuses a table it cannot find a url in, leaving the file untouched', async () => {
    fs.mkdirSync(path.dirname(codexConfig()), { recursive: true });
    const original = '[mcp_servers.subtext]\ncommand = "npx"\nargs = ["subtext"]\n';
    fs.writeFileSync(codexConfig(), original);

    await setup(codex());

    expect(read(codexConfig())).toBe(original);
    expect(events()).toContainEqual(['plugin_setup_failed', null]);
    expect(output()).toContain('Add it by hand');
  });

  it('does not mistake a commented-out header for the real table', async () => {
    fs.mkdirSync(path.dirname(codexConfig()), { recursive: true });
    fs.writeFileSync(codexConfig(), '# [mcp_servers.subtext]\n');

    await setup(codex());

    expect(read(codexConfig())).toContain(`[mcp_servers.subtext]\nurl = "${US_URL}"`);
  });

  it('writes nothing in mock mode', async () => {
    await setup(codex(), 'us', { mock: true });

    expect(fs.existsSync(codexConfig())).toBe(false);
    expect(events()).toContainEqual(['plugin_setup_completed', 'mock']);
  });
});

// ---------------------------------------------------------------------------

describe('Claude Code (packaged plugin, JSON fallback)', () => {
  const installedPlugins = () =>
    path.join(home, '.claude', 'plugins', 'installed_plugins.json');

  function writeInstalledPlugins(entries: unknown[]) {
    fs.mkdirSync(path.dirname(installedPlugins()), { recursive: true });
    fs.writeFileSync(installedPlugins(), JSON.stringify({ plugins: { [PLUGIN_SPEC]: entries } }));
  }

  it('installs the marketplace plugin through the harness CLI', async () => {
    await setup(claudeCode());

    const calls = h.runTerminalAgent.mock.calls.map((c) => c[0].args);
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'add', PLUGIN_REPO_URL],
      ['plugin', 'install', PLUGIN_SPEC],
    ]);
    expect(events()).toContainEqual(['plugin_setup_completed', 'plugin-cli']);
    expect(fs.existsSync(mcpJson())).toBe(false);
  });

  // The marketplace add errors when it is already registered, which is the
  // normal case on a re-run. Only the install itself decides success.
  it('continues when the marketplace add fails', async () => {
    h.runTerminalAgent.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await setup(claudeCode());

    expect(events()).toContainEqual(['plugin_setup_completed', 'plugin-cli']);
  });

  it('skips everything when the plugin is already installed for this user', async () => {
    writeInstalledPlugins([{ scope: 'user' }]);

    await setup(claudeCode());

    expect(h.runTerminalAgent).not.toHaveBeenCalled();
    expect(events()).toContainEqual(['plugin_setup_completed', 'already-installed']);
  });

  it('counts a project-scoped install only for the directory being instrumented', async () => {
    writeInstalledPlugins([{ scope: 'project', projectPath: projectDir }]);
    await setup(claudeCode());
    expect(h.runTerminalAgent).not.toHaveBeenCalled();

    vi.clearAllMocks();
    writeInstalledPlugins([{ scope: 'project', projectPath: '/somewhere/else' }]);
    await setup(claudeCode());
    expect(h.runTerminalAgent).toHaveBeenCalled();
  });

  it('treats a corrupt installed_plugins.json as not installed', async () => {
    fs.mkdirSync(path.dirname(installedPlugins()), { recursive: true });
    fs.writeFileSync(installedPlugins(), '{ not json');

    await setup(claudeCode());

    expect(h.runTerminalAgent).toHaveBeenCalled();
  });

  describe('falling back to a raw MCP entry', () => {
    beforeEach(() => {
      // Marketplace add succeeds, plugin install fails.
      h.runTerminalAgent.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    });

    it('writes a project-scoped .mcp.json', async () => {
      await setup(claudeCode());

      expect(JSON.parse(read(mcpJson()))).toEqual({
        mcpServers: { subtext: { type: 'http', url: US_URL } },
      });
      expect(events()).toContainEqual(['plugin_setup_completed', 'config-write-fallback']);
    });

    it('preserves other servers and the user’s own extras', async () => {
      fs.writeFileSync(
        mcpJson(),
        JSON.stringify({
          mcpServers: {
            other: { type: 'http', url: 'https://other.test' },
            subtext: { type: 'http', url: US_URL, headers: { 'X-Team': 'web' } },
          },
        }),
      );

      await setup(claudeCode());

      const config = JSON.parse(read(mcpJson()));
      expect(config.mcpServers.other).toEqual({ type: 'http', url: 'https://other.test' });
      expect(config.mcpServers.subtext.headers).toEqual({ 'X-Team': 'web' });
    });

    // A stale httpUrl beside the new url would leave two transports declared.
    it('drops a competing transport field it is not setting', async () => {
      fs.writeFileSync(
        mcpJson(),
        JSON.stringify({
          mcpServers: { subtext: { httpUrl: 'https://old.test', command: 'npx', url: US_URL } },
        }),
      );

      await setup(claudeCode());

      expect(JSON.parse(read(mcpJson())).mcpServers.subtext).toEqual({
        type: 'http',
        url: US_URL,
      });
    });

    it('never rewrites a config it cannot parse', async () => {
      const original = '{\n  // a JSONC comment\n  "mcpServers": {}\n}';
      fs.writeFileSync(mcpJson(), original);

      await setup(claudeCode());

      expect(read(mcpJson())).toBe(original);
      expect(events()).toContainEqual(['plugin_setup_failed', null]);
    });

    it('never rewrites a config whose root is not an object', async () => {
      fs.writeFileSync(mcpJson(), '["not", "an", "object"]');

      await setup(claudeCode());

      expect(read(mcpJson())).toBe('["not", "an", "object"]');
      expect(events()).toContainEqual(['plugin_setup_failed', null]);
    });

    it('never rewrites a config whose mcpServers is not an object', async () => {
      const original = JSON.stringify({ mcpServers: 'see the other file' });
      fs.writeFileSync(mcpJson(), original);

      await setup(claudeCode());

      expect(read(mcpJson())).toBe(original);
      expect(events()).toContainEqual(['plugin_setup_failed', null]);
    });
  });

  /**
   * A working plugin supersedes a raw entry left by an earlier run, or the
   * harness loads Subtext twice. Only an entry pointing at one of our own
   * endpoints is removed.
   */
  describe('superseding an earlier raw entry', () => {
    it('removes the entry it wrote once the plugin installs', async () => {
      fs.writeFileSync(
        mcpJson(),
        JSON.stringify({ mcpServers: { subtext: { type: 'http', url: US_URL } } }),
      );

      await setup(claudeCode());

      expect(JSON.parse(read(mcpJson())).mcpServers).toEqual({});
    });

    it('leaves a server the user pointed somewhere else alone', async () => {
      const mine = { mcpServers: { subtext: { type: 'http', url: 'https://my-proxy.test' } } };
      fs.writeFileSync(mcpJson(), JSON.stringify(mine));

      await setup(claudeCode());

      expect(JSON.parse(read(mcpJson()))).toEqual(mine);
    });

    it('leaves other servers in place', async () => {
      fs.writeFileSync(
        mcpJson(),
        JSON.stringify({
          mcpServers: {
            subtext: { type: 'http', url: US_URL },
            other: { type: 'http', url: 'https://other.test' },
          },
        }),
      );

      await setup(claudeCode());

      expect(JSON.parse(read(mcpJson())).mcpServers).toEqual({
        other: { type: 'http', url: 'https://other.test' },
      });
    });
  });
});

// ---------------------------------------------------------------------------

describe('Gemini', () => {
  it('installs the extension through the CLI', async () => {
    await setup(gemini());

    expect(h.runTerminalAgent.mock.calls[0][0].args).toEqual([
      'extensions',
      'install',
      PLUGIN_REPO_URL,
    ]);
  });

  it('detects an existing extension directory', async () => {
    fs.mkdirSync(path.join(home, '.gemini', 'extensions', 'subtext'), { recursive: true });

    await setup(gemini());

    expect(h.runTerminalAgent).not.toHaveBeenCalled();
    expect(events()).toContainEqual(['plugin_setup_completed', 'already-installed']);
  });

  it('falls back to user-global settings.json with the consolidated schema', async () => {
    h.runTerminalAgent.mockResolvedValueOnce(1);

    await setup(gemini());

    expect(JSON.parse(read(geminiSettings()))).toEqual({
      mcpServers: { subtext: { url: US_URL, type: 'http' } },
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * The packaged plugin ships the NA endpoint only, so an EU org must never
 * take that path — it would talk to the wrong realm.
 */
describe('EU orgs', () => {
  it('writes the EU server directly instead of installing the plugin', async () => {
    await setup(claudeCode(), 'eu');

    expect(h.runTerminalAgent).not.toHaveBeenCalled();
    expect(JSON.parse(read(mcpJson())).mcpServers.subtext.url).toBe(EU_URL);
  });

  it('warns when the NA plugin is already installed alongside', async () => {
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { [PLUGIN_SPEC]: [{ scope: 'user' }] } }),
    );

    await setup(claudeCode(), 'eu');

    expect(String(clack.log.warn.mock.calls[0][0])).toMatch(/only includes the NA MCP server/);
  });

  it('points Claude Code users at openskills for the review skills', async () => {
    await setup(claudeCode(), 'eu');
    expect(output()).toContain('npx openskills install fullstorydev/subtext');
  });

  /**
   * The EU raw entry is the org's only MCP source, so it has to survive a
   * re-run. (removeSupersededRawEntry also guards on region, but that guard
   * is unreachable today — it is only called from the packaged-plugin path,
   * which EU never takes. Harmless, but it is belt-and-braces, not the thing
   * keeping this safe.)
   */
  it('keeps the EU entry across a re-run', async () => {
    fs.writeFileSync(
      mcpJson(),
      JSON.stringify({ mcpServers: { subtext: { type: 'http', url: EU_URL } } }),
    );

    await setup(claudeCode(), 'eu');

    expect(JSON.parse(read(mcpJson())).mcpServers.subtext.url).toBe(EU_URL);
  });

  it('gives Codex the EU url', async () => {
    await setup(codex(), 'eu');
    expect(read(codexConfig())).toContain(EU_URL);
  });
});

// ---------------------------------------------------------------------------

/**
 * By the time this step runs the install has already succeeded. Unlike every
 * earlier prompt, Ctrl+C here means "skip the rest of this step", not "abort
 * the run" — exit 130 and "nothing was changed" would both be lies.
 */
describe('consent prompts', () => {
  it('asks before touching a config when no consent was captured', async () => {
    clack.confirm.mockResolvedValueOnce(true);

    await setupAsking(codex());

    expect(clack.confirm).toHaveBeenCalledOnce();
    expect(String(clack.confirm.mock.calls[0][0].message)).toContain('.codex/config.toml');
    expect(fs.existsSync(codexConfig())).toBe(true);
  });

  it('leaves instructions and writes nothing on an explicit no', async () => {
    clack.confirm.mockResolvedValueOnce(false);

    await setupAsking(codex());

    expect(fs.existsSync(codexConfig())).toBe(false);
    expect(events()).toContainEqual(['plugin_setup_declined', null]);
    expect(output()).toContain('Add it later');
  });

  it('skips quietly on Ctrl+C without throwing', async () => {
    clack.confirm.mockResolvedValueOnce(clack.cancel$);

    await expect(setupAsking(codex())).resolves.toBeUndefined();

    expect(fs.existsSync(codexConfig())).toBe(false);
    expect(onEvent).toHaveBeenCalledWith('plugin_setup_declined', {
      agent: 'codex',
      cancelled: true,
    });
  });

  it('proceeds without asking under --yes', async () => {
    await setupAsking(codex(), 'us', { yes: true });

    expect(clack.confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(codexConfig())).toBe(true);
  });

  // Approving a plugin install is not approving an edit to a config file.
  it('asks a second time before the raw-entry fallback', async () => {
    h.runTerminalAgent.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    clack.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await setupAsking(claudeCode());

    expect(clack.confirm).toHaveBeenCalledTimes(2);
    expect(String(clack.confirm.mock.calls[1][0].message)).toContain('.mcp.json');
    expect(fs.existsSync(mcpJson())).toBe(false);
  });
});

describe('an agent with no writable config', () => {
  it('falls back to instructions', async () => {
    await setup(agent('zed', 'Zed'));

    expect(events()).toContainEqual(['plugin_setup_completed', 'instructions']);
    expect(output()).toContain(US_URL);
  });

  it('cannot install a packaged plugin without a binary path', async () => {
    await setup(agentWithoutBinary('claude-code', 'Claude Code'));

    expect(h.runTerminalAgent).not.toHaveBeenCalled();
    expect(JSON.parse(read(mcpJson())).mcpServers.subtext.url).toBe(US_URL);
  });
});

// ---------------------------------------------------------------------------

/**
 * The GUI counterpart, which runs before the handoff. Its outcome decides
 * who owns telemetry, so unlike offerPluginSetup a Ctrl+C here does abort.
 */
describe('guidePluginSetup', () => {
  const cursorAgent = { definition: { id: 'cursor', name: 'Cursor' } } as DetectedAgent;

  it('points at the marketplace and reports the answer', async () => {
    clack.confirm.mockResolvedValueOnce(true);

    await expect(guidePluginSetup(cursorAgent, 'us')).resolves.toBe(true);
    expect(String(clack.note.mock.calls[0][0])).toContain('Marketplace');
  });

  it('continues without the plugin on a no', async () => {
    clack.confirm.mockResolvedValueOnce(false);

    await expect(guidePluginSetup(cursorAgent, 'us')).resolves.toBe(false);
    expect(output()).toContain('Continuing without the plugin');
  });

  it('gives EU orgs the raw server instead of the marketplace', async () => {
    clack.confirm.mockResolvedValueOnce(true);

    await guidePluginSetup(cursorAgent, 'eu');

    expect(String(clack.note.mock.calls[0][0])).toContain(EU_URL);
    expect(String(clack.note.mock.calls[0][0])).not.toContain('Marketplace panel');
  });

  it('gives Claude Desktop the connector flow', async () => {
    clack.confirm.mockResolvedValueOnce(true);
    const desktop = { definition: { id: 'claude-desktop', name: 'Claude Desktop' } } as DetectedAgent;

    await guidePluginSetup(desktop, 'us');

    expect(String(clack.note.mock.calls[0][0])).toContain('Add custom connector');
  });

  it('aborts the run on Ctrl+C, unlike the post-install step', async () => {
    const { CancelledError } = await import('./integrations.js');
    clack.confirm.mockResolvedValueOnce(clack.cancel$);

    await expect(guidePluginSetup(cursorAgent, 'us')).rejects.toBeInstanceOf(CancelledError);
  });
});
