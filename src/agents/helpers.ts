import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  /** Extra environment variables merged over the wizard's own. */
  env?: Record<string, string>;
  /** 'inherit' streams the agent's own output; 'pipe' lets the caller parse it. */
  stdout?: 'inherit' | 'pipe';
  onStdoutLine?: (line: string) => void;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.binaryPath, opts.args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
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
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) opts.onStdoutLine!(line);
        }
      });
    }

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
