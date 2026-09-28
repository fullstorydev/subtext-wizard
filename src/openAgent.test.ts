import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clackStub } from './test/helpers.js';
import type { OpenAgentTarget } from './openAgent.js';

/**
 * Opening a terminal harness composes a shell command inside an AppleScript
 * string literal, then hands the whole thing to osascript. The project
 * directory is attacker-adjacent input (it's whatever path the user is in),
 * so the two quoting layers are an injection boundary, not formatting.
 */

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const h = vi.hoisted(() => ({
  execFileAsync: vi.fn<(cmd: string, args: string[]) => Promise<{ stdout: string }>>(async () => ({
    stdout: '',
  })),
  openAppAtDir: vi.fn<(opts: Record<string, unknown>) => Promise<void>>(async () => undefined),
  clipboardWrite: vi.fn<(text: string) => Promise<void>>(async () => undefined),
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [promisify.custom]: h.execFileAsync }),
  spawn: vi.fn(),
}));
vi.mock('./agents/helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agents/helpers.js')>();
  return { ...actual, openAppAtDir: h.openAppAtDir };
});
vi.mock('clipboardy', () => ({ default: { write: h.clipboardWrite } }));

const { canOpenAgent, offerCopyAndOpen } = await import('./openAgent.js');

// ---------------------------------------------------------------------------

const terminal = (dir = '/work/app'): OpenAgentTarget => ({
  kind: 'terminal',
  name: 'Claude Code',
  binaryPath: '/usr/local/bin/claude',
  dir,
});

const app = (over: Partial<OpenAgentTarget> = {}): OpenAgentTarget => ({
  kind: 'app',
  name: 'Cursor',
  binaryPath: '/usr/local/bin/cursor',
  opensFolder: true,
  dir: '/work/app',
  ...over,
});

let realPlatform: PropertyDescriptor;

beforeEach(() => {
  realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  // Most tests are about what happens after the user says yes; the ones that
  // aren't override this.
  clack.confirm.mockResolvedValue(true);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.resetAllMocks();
  h.execFileAsync.mockResolvedValue({ stdout: '' });
});

function asTerminalApp() {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.stubEnv('TERM_PROGRAM', 'Apple_Terminal');
}

/** The AppleScript body osascript was asked to run. */
const script = () => h.execFileAsync.mock.calls[0][1][1];

const opts = (over: Partial<Parameters<typeof offerCopyAndOpen>[0]> = {}) => ({
  prompt: 'review my session',
  agentName: 'Claude Code',
  label: 'demo prompt',
  readyHint: "after you've clicked around",
  onEvent: vi.fn(),
  copiedEvent: 'demo_prompt_copied',
  openedEvent: 'demo_agent_opened',
  ...over,
});

// ---------------------------------------------------------------------------

/**
 * Deciding whether we *can* open the agent has to be side-effect free, so
 * callers can choose between an "Open …" offer and a plain copy without
 * launching anything.
 */
describe('canOpenAgent', () => {
  it('opens a terminal harness only on macOS Terminal.app with a binary', () => {
    asTerminalApp();
    expect(canOpenAgent(terminal())).toBe(true);
  });

  it('declines a terminal harness in another emulator', () => {
    asTerminalApp();
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    expect(canOpenAgent(terminal())).toBe(false);
  });

  it.each(['linux', 'win32'] as const)('declines a terminal harness on %s', (os) => {
    Object.defineProperty(process, 'platform', { value: os, configurable: true });
    vi.stubEnv('TERM_PROGRAM', 'Apple_Terminal');
    expect(canOpenAgent(terminal())).toBe(false);
  });

  it('declines a terminal harness with no binary', () => {
    asTerminalApp();
    expect(canOpenAgent({ ...terminal(), binaryPath: undefined })).toBe(false);
  });

  it('opens a GUI app given either a CLI or a bundle', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(canOpenAgent(app())).toBe(true);
    expect(canOpenAgent(app({ binaryPath: undefined, macAppName: 'Cursor' }))).toBe(true);
    expect(canOpenAgent(app({ binaryPath: undefined, macAppName: undefined }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('opening a terminal harness', () => {
  it('cds into the project and launches the binary', async () => {
    asTerminalApp();
    await offerCopyAndOpen(opts({ target: terminal() }));

    expect(h.execFileAsync.mock.calls[0][0]).toBe('osascript');
    expect(script()).toContain(`cd '/work/app' && '/usr/local/bin/claude'`);
  });

  /**
   * A directory containing a single quote would otherwise close the shell
   * quote and let everything after it run as a command.
   */
  it('neutralises a single quote in the project path', async () => {
    asTerminalApp();
    await offerCopyAndOpen(opts({ target: terminal(`/work/it's; rm -rf ~`) }));

    const body = script();
    expect(body).toContain(`'/work/it'\\\\''s; rm -rf ~'`);
    // The injected command never escapes into an unquoted position.
    expect(body).not.toMatch(/&&\s*rm -rf/);
  });

  it('escapes quotes and backslashes for the AppleScript literal', async () => {
    asTerminalApp();
    await offerCopyAndOpen(opts({ target: terminal('/work/a"b\\c') }));

    const body = script();
    // Inside `do script "…"`, both characters have to arrive escaped or the
    // literal ends early and osascript sees broken syntax.
    expect(body).toContain('\\"');
    expect(body).toContain('\\\\');
    expect(body.startsWith('tell application "Terminal" to do script "')).toBe(true);
    expect(body.endsWith('"')).toBe(true);
  });

  it('reports the new window and where to paste', async () => {
    asTerminalApp();
    const o = opts({ target: terminal() });
    await offerCopyAndOpen(o);

    expect(o.onEvent).toHaveBeenCalledWith('demo_agent_opened', { kind: 'terminal' });
    expect(String(clack.log.success.mock.calls[0][0])).toMatch(/Opened a new Terminal window/);
  });

  it('still reports the copy when osascript fails', async () => {
    asTerminalApp();
    h.execFileAsync.mockRejectedValueOnce(new Error('osascript: -1743'));
    const o = opts({ target: terminal() });

    await offerCopyAndOpen(o);

    expect(o.onEvent).toHaveBeenCalledWith('demo_prompt_copied');
    expect(o.onEvent).not.toHaveBeenCalledWith('demo_agent_opened', expect.anything());
    expect(String(clack.log.success.mock.calls[0][0])).toMatch(/copied — open Claude Code/);
  });
});

describe('opening a GUI app', () => {
  it('passes the project folder to an app that opens folders', async () => {
    await offerCopyAndOpen(opts({ target: app() }));
    expect(h.openAppAtDir).toHaveBeenCalledWith(expect.objectContaining({ dir: '/work/app' }));
  });

  it('withholds the folder from an app that does not open them', async () => {
    await offerCopyAndOpen(opts({ target: app({ opensFolder: false }) }));
    expect(h.openAppAtDir).toHaveBeenCalledWith(expect.objectContaining({ dir: undefined }));
  });

  it('falls back to a copy-only message when the launch fails', async () => {
    h.openAppAtDir.mockRejectedValueOnce(new Error('nope'));
    await offerCopyAndOpen(opts({ target: app() }));

    expect(String(clack.log.success.mock.calls[0][0])).toMatch(/copied — open Claude Code/);
  });
});

// ---------------------------------------------------------------------------

describe('the copy offer', () => {
  it('bundles opening and copying into one question when it can', async () => {
    asTerminalApp();
    await offerCopyAndOpen(opts({ target: terminal() }));

    expect(String(clack.confirm.mock.calls[0][0].message)).toMatch(
      /Open Claude Code and copy the demo prompt/,
    );
  });

  it('degrades to copy-only for an unknown harness', async () => {
    await offerCopyAndOpen(opts());

    expect(String(clack.confirm.mock.calls[0][0].message)).toMatch(/^Copy the demo prompt above/);
    expect(h.openAppAtDir).not.toHaveBeenCalled();
  });

  /**
   * On the app and manual paths the clipboard still holds the install prompt
   * the user has not pasted yet. Reopening the editor must not force them to
   * overwrite it, so the bundled offer degrades and the copy stays a
   * deliberate, warned-about choice.
   */
  it('degrades and warns when the clipboard is still needed', async () => {
    asTerminalApp();
    await offerCopyAndOpen(opts({ target: terminal(), clipboardBusy: true }));

    const message = String(clack.confirm.mock.calls[0][0].message);
    expect(message).toMatch(/^Copy the demo prompt above/);
    expect(message).toMatch(/replaces what's on your clipboard now/);
    expect(h.execFileAsync).not.toHaveBeenCalled();
  });

  it('does nothing on a decline', async () => {
    clack.confirm.mockResolvedValueOnce(false);
    const o = opts({ target: app() });

    await offerCopyAndOpen(o);

    expect(h.clipboardWrite).not.toHaveBeenCalled();
    expect(h.openAppAtDir).not.toHaveBeenCalled();
    expect(o.onEvent).not.toHaveBeenCalled();
  });

  it('does nothing on Ctrl+C, without throwing', async () => {
    clack.confirm.mockResolvedValueOnce(clack.cancel$);

    await expect(offerCopyAndOpen(opts({ target: app() }))).resolves.toBeUndefined();
    expect(h.clipboardWrite).not.toHaveBeenCalled();
  });

  it('does not open the agent when the clipboard write fails', async () => {
    h.clipboardWrite.mockRejectedValueOnce(new Error('no clipboard'));
    const o = opts({ target: app() });

    await offerCopyAndOpen(o);

    expect(h.openAppAtDir).not.toHaveBeenCalled();
    expect(o.onEvent).not.toHaveBeenCalled();
    expect(String(clack.log.warn.mock.calls[0][0])).toMatch(/Could not write to the clipboard/);
  });

  it('copies the prompt verbatim', async () => {
    await offerCopyAndOpen(opts({ prompt: 'exact text' }));
    expect(h.clipboardWrite).toHaveBeenCalledWith('exact text');
  });
});
