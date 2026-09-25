import { afterEach, describe, expect, it, vi } from 'vitest';
import { clackStub, makeOptions } from '../test/helpers.js';
import type { AgentDefinition, DetectedAgent } from './types.js';

/**
 * The real AGENTS list probes the machine — PATH lookups, ~/.claude, macOS
 * bundles — so detection results would depend on whatever the runner happens
 * to have installed. Substitute the four agent modules with fakes instead, so
 * both the ordering and the failure handling are deterministic.
 */
const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const fakes = vi.hoisted(() => {
  const make = (id: string, name: string, kind: 'terminal' | 'app'): AgentDefinition => ({
    id,
    name,
    kind,
    detect: vi.fn(async () => null),
    launch: vi.fn(async () => ({ mode: 'ran' as const, exitCode: 0 })),
  });
  return {
    claudeCode: make('claude-code', 'Claude Code', 'terminal'),
    codexCli: make('codex', 'Codex CLI', 'terminal'),
    geminiCli: make('gemini', 'Gemini CLI', 'terminal'),
    cursor: make('cursor', 'Cursor', 'app'),
    windsurf: make('windsurf', 'Windsurf', 'app'),
    vscode: make('vscode', 'VS Code', 'app'),
    zed: make('zed', 'Zed', 'app'),
    claudeDesktop: make('claude-desktop', 'Claude Desktop', 'app'),
  };
});

vi.mock('./claude-code.js', () => ({ claudeCode: fakes.claudeCode }));
vi.mock('./codex.js', () => ({ codexCli: fakes.codexCli }));
vi.mock('./gemini.js', () => ({ geminiCli: fakes.geminiCli }));
vi.mock('./apps.js', () => ({
  cursor: fakes.cursor,
  windsurf: fakes.windsurf,
  vscode: fakes.vscode,
  zed: fakes.zed,
  claudeDesktop: fakes.claudeDesktop,
}));

const { AGENTS, MANUAL_CHOICE, chooseAgent, detectAgents } = await import('./index.js');
const { CancelledError } = await import('../integrations.js');

/** Make one fake report itself as installed. */
function installed(definition: AgentDefinition, extra: Partial<DetectedAgent> = {}) {
  const found: DetectedAgent = { definition, binaryPath: `/bin/${definition.id}`, ...extra };
  vi.mocked(definition.detect).mockResolvedValue(found);
  return found;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const agent of Object.values(fakes)) {
    vi.mocked(agent.detect).mockResolvedValue(null);
  }
});

// ---------------------------------------------------------------------------

describe('AGENTS', () => {
  // Terminal agents run the install unattended; app handoffs need the user to
  // paste. The better experience should be offered first.
  it('lists terminal agents before app handoffs', () => {
    const firstApp = AGENTS.findIndex((a) => a.kind === 'app');
    const lastTerminal = AGENTS.map((a) => a.kind).lastIndexOf('terminal');
    expect(lastTerminal).toBeLessThan(firstApp);
  });

  it('has unique ids', () => {
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(AGENTS.length);
  });
});

describe('detectAgents', () => {
  it('returns nothing when no agent is installed', async () => {
    expect(await detectAgents()).toEqual([]);
  });

  it('returns only the installed agents, in catalog order', async () => {
    installed(fakes.cursor);
    installed(fakes.codexCli);

    expect((await detectAgents()).map((d) => d.definition.id)).toEqual(['codex', 'cursor']);
  });

  // A broken probe on one agent must not cost the user the others.
  it('drops an agent whose detect() rejects', async () => {
    vi.mocked(fakes.claudeCode.detect).mockRejectedValue(new Error('spawn EACCES'));
    installed(fakes.codexCli);

    expect((await detectAgents()).map((d) => d.definition.id)).toEqual(['codex']);
  });

  it('survives every probe rejecting', async () => {
    for (const agent of Object.values(fakes)) {
      vi.mocked(agent.detect).mockRejectedValue(new Error('nope'));
    }
    await expect(detectAgents()).resolves.toEqual([]);
  });

  it('probes every agent', async () => {
    await detectAgents();
    for (const agent of Object.values(fakes)) {
      expect(agent.detect).toHaveBeenCalledOnce();
    }
  });
});

// ---------------------------------------------------------------------------

describe('chooseAgent with --agent', () => {
  it('picks a detected agent by id without prompting', async () => {
    const codex = installed(fakes.codexCli);
    const detected = await detectAgents();

    const chosen = await chooseAgent(detected, makeOptions({ agent: 'codex' }));

    expect(chosen).toBe(codex);
    expect(clack.select).not.toHaveBeenCalled();
  });

  it('accepts the manual sentinel', async () => {
    const chosen = await chooseAgent([], makeOptions({ agent: 'manual' }));
    expect(chosen).toBe(MANUAL_CHOICE);
  });

  // Silently falling back to the picker would strand a CI run at a prompt.
  it('throws for an id that was not detected, naming what was', async () => {
    installed(fakes.cursor);
    const detected = await detectAgents();

    await expect(chooseAgent(detected, makeOptions({ agent: 'codex' }))).rejects.toThrow(
      /Agent 'codex' was not detected\. Detected: cursor\./,
    );
  });

  it('says "none" when nothing at all was detected', async () => {
    await expect(chooseAgent([], makeOptions({ agent: 'codex' }))).rejects.toThrow(
      /Detected: none\./,
    );
  });
});

describe('chooseAgent interactively', () => {
  const options = () =>
    (clack.select.mock.calls[0][0] as { options: Array<{ value: string; hint?: string }> }).options;

  it('falls back to the manual prompt when nothing is detected', async () => {
    const chosen = await chooseAgent([], makeOptions());

    expect(chosen).toBe(MANUAL_CHOICE);
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.log.warn).toHaveBeenCalled();
  });

  it('offers each detected agent plus the manual escape hatch', async () => {
    installed(fakes.claudeCode);
    installed(fakes.cursor);
    const detected = await detectAgents();
    clack.select.mockResolvedValueOnce('claude-code');

    await chooseAgent(detected, makeOptions());

    expect(options().map((o) => o.value)).toEqual(['claude-code', 'cursor', MANUAL_CHOICE]);
  });

  // The hint is how the user learns a terminal agent will just do it, while a
  // GUI handoff means pasting the prompt themselves.
  it('distinguishes terminal agents from app handoffs in the hints', async () => {
    installed(fakes.claudeCode);
    installed(fakes.cursor);
    const detected = await detectAgents();
    clack.select.mockResolvedValueOnce('cursor');

    await chooseAgent(detected, makeOptions());

    expect(options()[0].hint).toMatch(/runs automatically/);
    expect(options()[1].hint).toMatch(/opens the app/);
  });

  it('returns the chosen agent', async () => {
    installed(fakes.claudeCode);
    const cursor = installed(fakes.cursor);
    const detected = await detectAgents();
    clack.select.mockResolvedValueOnce('cursor');

    expect(await chooseAgent(detected, makeOptions())).toBe(cursor);
  });

  it('returns the sentinel when the user asks for the raw prompt', async () => {
    installed(fakes.claudeCode);
    const detected = await detectAgents();
    clack.select.mockResolvedValueOnce(MANUAL_CHOICE);

    expect(await chooseAgent(detected, makeOptions())).toBe(MANUAL_CHOICE);
  });

  it('reports which binary it will use when detection found a path', async () => {
    installed(fakes.claudeCode, { detail: '/opt/homebrew/bin/claude' });
    const detected = await detectAgents();
    clack.select.mockResolvedValueOnce('claude-code');

    await chooseAgent(detected, makeOptions());

    expect(String(clack.log.info.mock.calls[0][0])).toContain('/opt/homebrew/bin/claude');
  });

  it('stays quiet when there is no detail to report', async () => {
    installed(fakes.claudeCode, { detail: undefined });
    const detected = await detectAgents();
    clack.select.mockResolvedValueOnce('claude-code');

    await chooseAgent(detected, makeOptions());

    expect(clack.log.info).not.toHaveBeenCalled();
  });

  it('aborts the run when the picker is cancelled', async () => {
    installed(fakes.claudeCode);
    const detected = await detectAgents();
    clack.select.mockResolvedValueOnce(clack.cancel$);

    await expect(chooseAgent(detected, makeOptions())).rejects.toBeInstanceOf(CancelledError);
  });
});
