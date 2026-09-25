import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * promisify(execFile) is resolved at module load, so the mock has to carry
 * the same custom symbol the real execFile does — otherwise promisify wraps
 * it callback-style and `const { stdout } = await …` comes back undefined.
 */
const { execFileAsync, spawn, homedir } = vi.hoisted(() => ({
  execFileAsync: vi.fn<(cmd: string, args: string[]) => Promise<{ stdout: string }>>(),
  spawn: vi.fn(),
  homedir: vi.fn<() => string>(),
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [promisify.custom]: execFileAsync }),
  spawn,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir }, homedir };
});

const {
  firstExistingPath,
  macAppPath,
  openAppAtDir,
  runTerminalAgent,
  sanitizeTerminalOutput,
  which,
} = await import('./helpers.js');

// ---------------------------------------------------------------------------

// Built from char codes rather than string escapes so the control bytes stay
// visible in the source instead of becoming invisible characters in the file.
const chr = (...codes: number[]) => String.fromCharCode(...codes);
const ESC = chr(0x1b);
const BEL = chr(0x07);
/** An escape byte is only allowed to survive if it opens a colour sequence. */
const SGR_START = new RegExp(`^${ESC}\\[[0-9;:?]*m`);

let tmp: string;
let realPlatform: PropertyDescriptor;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'subtext-helpers-'));
  homedir.mockReturnValue(tmp);
  realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

// ---------------------------------------------------------------------------

/**
 * Agents echo arbitrary repo content — READMEs, file bodies, command output —
 * straight into the user's terminal through the wizard. Escape sequences in
 * that stream can spoof output or drive the terminal, so what survives this
 * function is a security boundary, not a formatting choice.
 */
describe('sanitizeTerminalOutput', () => {
  it('leaves ordinary text alone', () => {
    expect(sanitizeTerminalOutput('installing the snippet')).toBe('installing the snippet');
  });

  it('keeps SGR colour so the agent’s own output still renders', () => {
    const colored = `${ESC}[31mred${ESC}[0m and ${ESC}[1;32mbold green${ESC}[m`;
    expect(sanitizeTerminalOutput(colored)).toBe(colored);
  });

  // OSC 52 writes the user's clipboard. The wizard puts install prompts there,
  // so an agent echoing repo content must not be able to reach it.
  it('strips a BEL-terminated OSC 52 clipboard write', () => {
    expect(sanitizeTerminalOutput(`${ESC}]52;c;cGF5bG9hZA==${BEL}after`)).toBe('after');
  });

  it('strips an ST-terminated OSC sequence', () => {
    expect(sanitizeTerminalOutput(`${ESC}]0;window title${ESC}\\after`)).toBe('after');
  });

  it.each([
    ['screen clear', `${ESC}[2J`],
    ['cursor home', `${ESC}[H`],
    ['cursor up', `${ESC}[3A`],
    ['scroll region', `${ESC}[1;40r`],
  ])('strips %s', (_label, sequence) => {
    expect(sanitizeTerminalOutput(`before${sequence}after`)).toBe('beforeafter');
  });

  it('strips a single-character escape sequence outright', () => {
    expect(sanitizeTerminalOutput(`${ESC}Mtext`)).toBe('text');
  });

  it('strips a stray escape that starts nothing', () => {
    expect(sanitizeTerminalOutput(`a${ESC}b`)).toBe('ab');
  });

  /**
   * The actual guarantee, and the only one that matters: no escape byte
   * survives unless it opens a colour sequence. A charset selection like
   * ESC ( B leaves "(B" behind as plain text — inert, since the terminal
   * has nothing left to act on.
   */
  it('leaves the payload of ESC ( B behind, but never the escape itself', () => {
    expect(sanitizeTerminalOutput(`${ESC}(Btext`)).toBe('(Btext');
  });

  it.each([
    ['osc 52', `${ESC}]52;c;ZQ==${BEL}`],
    ['charset', `${ESC}(B`],
    ['screen clear', `${ESC}[2J`],
    ['stray', `${ESC}`],
    ['device query', `${ESC}[?1049h`],
  ])('leaves no actionable escape byte after %s', (_label, sequence) => {
    const out = sanitizeTerminalOutput(`before${sequence}after`);
    // Any surviving ESC must be the start of a kept SGR sequence.
    for (const index of [...out].flatMap((c, i) => (c === ESC ? [i] : []))) {
      expect(out.slice(index)).toMatch(SGR_START);
    }
  });

  it('strips carriage returns and other C0 controls', () => {
    const line = `over${chr(0x0d)}write${chr(0x00)}${chr(0x08)}x${chr(0x7f)}`;
    expect(sanitizeTerminalOutput(line)).toBe('overwritex');
  });

  it('keeps tabs and newlines, which carry real formatting', () => {
    expect(sanitizeTerminalOutput(`a${chr(0x09)}b${chr(0x0a)}c`)).toBe('a\tb\nc');
  });

  it('handles a line mixing colour with an attack', () => {
    const line = `${ESC}[32mok${ESC}[0m${ESC}]52;c;ZXZpbA==${BEL}${ESC}[2Jdone`;
    expect(sanitizeTerminalOutput(line)).toBe(`${ESC}[32mok${ESC}[0mdone`);
  });
});

// ---------------------------------------------------------------------------

describe('which', () => {
  it('returns the first path the locator prints', async () => {
    execFileAsync.mockResolvedValue({ stdout: '/usr/local/bin/claude\n/opt/bin/claude\n' });
    expect(await which('claude')).toBe('/usr/local/bin/claude');
  });

  it('trims the result', async () => {
    execFileAsync.mockResolvedValue({ stdout: '  /usr/bin/codex  \n' });
    expect(await which('codex')).toBe('/usr/bin/codex');
  });

  it('returns null when the command is not found', async () => {
    execFileAsync.mockRejectedValue(new Error('exit 1'));
    expect(await which('nope')).toBeNull();
  });

  it('returns null for empty output', async () => {
    execFileAsync.mockResolvedValue({ stdout: '\n' });
    expect(await which('nope')).toBeNull();
  });

  it('uses `which` off Windows and `where` on it', async () => {
    execFileAsync.mockResolvedValue({ stdout: '/usr/bin/gemini\n' });
    setPlatform('linux');
    await which('gemini');
    expect(execFileAsync.mock.calls[0][0]).toBe('which');

    setPlatform('win32');
    await which('gemini');
    expect(execFileAsync.mock.calls[1][0]).toBe('where');
  });
});

describe('firstExistingPath', () => {
  it('returns the first path that exists', () => {
    const present = path.join(tmp, 'real');
    fs.writeFileSync(present, '');
    expect(firstExistingPath([path.join(tmp, 'missing'), present])).toBe(present);
  });

  it('returns null when none exist', () => {
    expect(firstExistingPath([path.join(tmp, 'a'), path.join(tmp, 'b')])).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(firstExistingPath([])).toBeNull();
  });
});

describe('macAppPath', () => {
  it('finds a bundle under the user’s Applications folder', () => {
    setPlatform('darwin');
    // A name nothing will have in /Applications — that path is checked first,
    // so a real install would otherwise win and make this machine-dependent.
    const bundle = path.join(tmp, 'Applications', 'SubtextTestHarness.app');
    fs.mkdirSync(bundle, { recursive: true });
    expect(macAppPath('SubtextTestHarness')).toBe(bundle);
  });

  it('returns null when no bundle is installed', () => {
    setPlatform('darwin');
    expect(macAppPath('DefinitelyNotInstalled9f2c')).toBeNull();
  });

  it.each(['linux', 'win32'] as const)('returns null on %s without touching the disk', (os) => {
    setPlatform(os);
    fs.mkdirSync(path.join(tmp, 'Applications', 'SubtextTestHarness.app'), { recursive: true });
    expect(macAppPath('SubtextTestHarness')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('openAppAtDir', () => {
  const child = () => ({ unref: vi.fn() });

  it('prefers the app’s own CLI launcher, passing the project directory', async () => {
    spawn.mockReturnValue(child());
    await openAppAtDir({ binaryPath: '/usr/local/bin/cursor', dir: '/work/app' });
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/cursor', ['/work/app'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('passes no path when the caller withholds the directory', async () => {
    spawn.mockReturnValue(child());
    await openAppAtDir({ binaryPath: '/usr/local/bin/cursor' });
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/cursor', [], expect.anything());
  });

  it('falls back to `open -a` on macOS when there is no CLI', async () => {
    setPlatform('darwin');
    spawn.mockReturnValue(child());
    await openAppAtDir({ macAppName: 'Claude', dir: '/work/app' });
    expect(spawn).toHaveBeenCalledWith('open', ['-a', 'Claude', '/work/app'], expect.anything());
  });

  it('detaches and unrefs so the wizard can exit', async () => {
    const spawned = child();
    spawn.mockReturnValue(spawned);
    await openAppAtDir({ binaryPath: '/bin/zed', dir: '/work' });
    expect(spawned.unref).toHaveBeenCalled();
  });

  it('throws when there is no way to launch on this platform', async () => {
    setPlatform('linux');
    await expect(openAppAtDir({ macAppName: 'Claude' })).rejects.toThrow(/No way to launch/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

/** Minimal stand-in for a spawned agent process. */
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
}

describe('runTerminalAgent', () => {
  function start(opts: Partial<Parameters<typeof runTerminalAgent>[0]> = {}) {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const exit = runTerminalAgent({
      binaryPath: '/bin/agent',
      args: ['-p'],
      cwd: '/work/app',
      ...opts,
    });
    return { child, exit };
  }

  const stdioOf = () => (spawn.mock.calls[0][2] as { stdio: string[] }).stdio;

  it('spawns the binary in the project directory and resolves the exit code', async () => {
    const { child, exit } = start();
    child.emit('close', 0);

    await expect(exit).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      '/bin/agent',
      ['-p'],
      expect.objectContaining({ cwd: '/work/app' }),
    );
  });

  it('passes a non-zero exit code through', async () => {
    const { child, exit } = start();
    child.emit('close', 3);
    await expect(exit).resolves.toBe(3);
  });

  it('treats a signal-killed process (null code) as a failure', async () => {
    const { child, exit } = start();
    child.emit('close', null);
    await expect(exit).resolves.toBe(1);
  });

  it('rejects when the process cannot be spawned', async () => {
    const { child, exit } = start();
    child.emit('error', new Error('ENOENT'));
    await expect(exit).rejects.toThrow('ENOENT');
  });

  it('writes the prompt to stdin and closes it', async () => {
    const { child, exit } = start({ promptOnStdin: 'do the install' });
    child.emit('close', 0);
    await exit;

    expect(child.stdin.write).toHaveBeenCalledWith('do the install');
    expect(child.stdin.end).toHaveBeenCalled();
    expect(stdioOf()).toEqual(['pipe', 'inherit', 'inherit']);
  });

  it('inherits stdin when there is no prompt to pipe', async () => {
    const { child, exit } = start();
    child.emit('close', 0);
    await exit;
    expect(stdioOf()).toEqual(['inherit', 'inherit', 'inherit']);
  });

  it('pipes stdout only when the caller wants to read it', async () => {
    const { child, exit } = start({ stdout: 'pipe', onStdoutLine: vi.fn() });
    child.emit('close', 0);
    await exit;
    expect(stdioOf()).toEqual(['inherit', 'pipe', 'inherit']);
  });

  describe('line buffering', () => {
    async function collect(chunks: string[], { end = true } = {}) {
      const lines: string[] = [];
      const { child, exit } = start({ stdout: 'pipe', onStdoutLine: (l) => lines.push(l) });
      for (const chunk of chunks) child.stdout.emit('data', chunk);
      if (end) child.stdout.emit('end');
      child.emit('close', 0);
      await exit;
      return lines;
    }

    it('splits a chunk into lines', async () => {
      expect(await collect(['one\ntwo\nthree\n'])).toEqual(['one', 'two', 'three']);
    });

    it('joins a line split across chunks', async () => {
      expect(await collect(['par', 'tial li', 'ne\n'])).toEqual(['partial line']);
    });

    it('delivers blank lines, which carry the agent’s formatting', async () => {
      expect(await collect(['a\n\nb\n'])).toEqual(['a', '', 'b']);
    });

    /**
     * The agent's closing summary — and its last telemetry marker — often
     * arrive with no trailing newline. Without the flush on 'end' they are
     * dropped and the funnel silently loses the final step.
     */
    it('flushes a trailing line that never got a newline', async () => {
      expect(await collect(['done\nfinal line with no newline'])).toEqual([
        'done',
        'final line with no newline',
      ]);
    });

    it('emits nothing extra when the stream ends on a newline', async () => {
      expect(await collect(['a\n'])).toEqual(['a']);
    });

    it('holds an unterminated line until the stream ends', async () => {
      expect(await collect(['no newline yet'], { end: false })).toEqual([]);
    });

    it('does not read the stream when no line handler was given', async () => {
      const { child, exit } = start({ stdout: 'pipe' });
      expect(child.stdout.listenerCount('data')).toBe(0);
      child.emit('close', 0);
      await exit;
    });
  });
});
