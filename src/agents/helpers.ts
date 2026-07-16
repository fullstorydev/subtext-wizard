import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Strip dangerous terminal control sequences from untrusted agent output
 * before echoing it to the user's terminal. Agents echo arbitrary repo content
 * (READMEs, file bodies, command output), which can carry escape sequences
 * that spoof output or abuse the terminal — e.g. OSC 52 clipboard writes.
 *
 * SGR color codes (CSI … m) are kept so the agent's colored output still
 * renders; OSC sequences, cursor/screen manipulation, other ESC sequences, and
 * stray C0 control chars (except tab/newline) are removed.
 */
export function sanitizeTerminalOutput(text: string): string {
  return (
    text
      // OSC: ESC ] … terminated by BEL or ST (ESC \) — e.g. OSC 52 clipboard.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // CSI: ESC [ … final byte — keep only SGR (ends in 'm'), drop the rest.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, (m) => (m.endsWith('m') ? m : ''))
      // Other ESC-introduced sequences (charset selection, single-char, etc.).
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
      // Any ESC that isn't starting a kept SGR sequence (malformed/stray).
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b(?!\[[0-9;:?]*[ -/]*m)/g, '')
      // Remaining C0 controls and DEL, except tab, newline, and ESC (ESC was
      // handled above so kept SGR codes survive this pass).
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '')
  );
}

/** Locate a command on PATH. Returns the resolved path or null. */
export async function which(cmd: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(locator, [cmd]);
    const first = stdout.split('\n')[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/** Return the first path that exists, or null. */
export function firstExistingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Check for a macOS app bundle in the usual locations. */
export function macAppPath(appName: string): string | null {
  if (process.platform !== 'darwin') return null;
  return firstExistingPath([
    `/Applications/${appName}.app`,
    path.join(os.homedir(), 'Applications', `${appName}.app`),
  ]);
}

/**
 * Open a GUI editor/agent app at the project directory.
 * Prefers the app's CLI launcher when available, falls back to `open -a`.
 */
export async function openAppAtDir(opts: {
  binaryPath?: string | null;
  macAppName?: string;
  dir?: string;
}): Promise<void> {
  const { binaryPath, macAppName, dir } = opts;
  const args = dir ? [dir] : [];
  if (binaryPath) {
    spawn(binaryPath, args, { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin' && macAppName) {
    spawn('open', ['-a', macAppName, ...args], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  throw new Error('No way to launch the app on this platform.');
}

/**
 * Run a terminal agent to completion in the current terminal.
 * The prompt is written to stdin unless `promptAsArg` places it in argv.
 */
export function runTerminalAgent(opts: {
  binaryPath: string;
  args: string[];
  cwd: string;
  promptOnStdin?: string;
  /** 'inherit' streams the agent's own output; 'pipe' lets the caller parse it. */
  stdout?: 'inherit' | 'pipe';
  onStdoutLine?: (line: string) => void;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.binaryPath, opts.args, {
      cwd: opts.cwd,
      stdio: [
        opts.promptOnStdin !== undefined ? 'pipe' : 'inherit',
        opts.stdout ?? 'inherit',
        'inherit',
      ],
    });

    if (opts.promptOnStdin !== undefined && child.stdin) {
      child.stdin.write(opts.promptOnStdin);
      child.stdin.end();
    }

    if (opts.stdout === 'pipe' && child.stdout && opts.onStdoutLine) {
      let buffer = '';
      child.stdout.setEncoding('utf8');
      // Blank lines are delivered too — callers that echo the stream back to
      // the terminal need them to preserve the agent's output formatting.
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          opts.onStdoutLine!(line);
        }
      });
      // Flush whatever follows the last newline once the stream ends — the
      // agent's final line (often its closing summary or last telemetry
      // marker) can arrive without a trailing '\n' and must not be dropped.
      child.stdout.on('end', () => {
        if (buffer) opts.onStdoutLine!(buffer);
        buffer = '';
      });
    }

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
