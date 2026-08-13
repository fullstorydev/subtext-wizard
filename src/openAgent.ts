import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as p from '@clack/prompts';
import clipboard from 'clipboardy';
import pc from 'picocolors';
import { openAppAtDir } from './agents/helpers.js';

const execFileAsync = promisify(execFile);

/**
 * A coding agent we can open for the user at a "paste this prompt" hand-off
 * (the first-run demo and the enrichment follow-up). We copy the prompt to the
 * clipboard and bring the agent up so the only thing left is a paste.
 */
export interface OpenAgentTarget {
  kind: 'terminal' | 'app';
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** CLI binary, when one was detected. Terminal agents need it to launch. */
  binaryPath?: string;
  /** macOS app bundle name, for GUI agents without a CLI launcher. */
  macAppName?: string;
  /** Project directory to open the agent at. */
  dir: string;
}

type OpenResult = 'opened' | 'failed';

/** POSIX single-quote a string for safe embedding in a shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escape a string for an AppleScript double-quoted literal. */
function osaQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Can we actually bring this agent up on the current machine? Callers use this
 * to decide between an "Open …" offer and the plain copy-only offer, without
 * the side effect of launching anything.
 *
 * - Terminal agents: macOS + Terminal.app only (we drive it via AppleScript).
 *   iTerm, other emulators, and non-macOS fall back to printed instructions.
 * - GUI apps: openAppAtDir handles them cross-platform when we have a CLI
 *   launcher; a mac app bundle name also works on macOS.
 */
export function canOpenAgent(target: OpenAgentTarget): boolean {
  if (target.kind === 'terminal') {
    return (
      !!target.binaryPath &&
      process.platform === 'darwin' &&
      process.env.TERM_PROGRAM === 'Apple_Terminal'
    );
  }
  return !!target.binaryPath || !!target.macAppName;
}

/**
 * Open a new Terminal.app window that cd's into the project and launches the
 * harness interactively. The prompt is already on the clipboard; the user
 * pastes it into the fresh session. macOS + Terminal.app only — guarded by
 * canOpenAgent before we get here.
 */
async function openTerminalHarness(binaryPath: string, dir: string): Promise<OpenResult> {
  const command = `cd ${shellQuote(dir)} && ${shellQuote(binaryPath)}`;
  try {
    await execFileAsync('osascript', [
      '-e',
      `tell application "Terminal" to do script "${osaQuote(command)}"`,
      '-e',
      'tell application "Terminal" to activate',
    ]);
    return 'opened';
  } catch {
    return 'failed';
  }
}

async function openAgent(target: OpenAgentTarget): Promise<OpenResult> {
  if (target.kind === 'terminal') {
    // binaryPath presence is guaranteed by canOpenAgent, but stay defensive.
    if (!target.binaryPath) return 'failed';
    return openTerminalHarness(target.binaryPath, target.dir);
  }
  try {
    // No dir: a GUI app is already open at the project from the install
    // hand-off, so we only need to bring it forward. Passing a folder to an app
    // that doesn't open folders (Claude Desktop, opensFolder: false) would run
    // `open -a Claude <path>`, which isn't how it launches.
    await openAppAtDir({
      binaryPath: target.binaryPath,
      macAppName: target.macAppName,
    });
    return 'opened';
  } catch {
    return 'failed';
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The shared tail of a prompt hand-off: offer to copy the prompt (and, when we
 * can, open the agent alongside it), then report what happened. Used by both
 * the first-run demo and the enrichment follow-up so the two stay consistent.
 *
 * When the agent is openable, one confirm both copies and launches it; when it
 * isn't (manual/unknown harness, iTerm, non-macOS), it degrades to the plain
 * copy-only offer. A launch that fails after the copy still leaves the prompt
 * on the clipboard, so the user just opens the agent themselves.
 */
export async function offerCopyAndOpen(opts: {
  prompt: string;
  agentName: string;
  /** Omit for the manual path (unknown harness) to force copy-only. */
  target?: OpenAgentTarget;
  /** The clipboard currently holds another prompt — warn before clobbering. */
  clipboardBusy?: boolean;
  /** What the prompt is, for messages: "demo prompt", "follow-up prompt". */
  label: string;
  /** Trailing hint on paste messages, e.g. "after you've clicked around". */
  readyHint: string;
  onEvent: (event: string, properties?: Record<string, unknown>) => void;
  copiedEvent: string;
  openedEvent: string;
}): Promise<void> {
  const { prompt, agentName, target, clipboardBusy, label, readyHint, onEvent } = opts;
  // Don't bundle "open the agent" with a clipboard-clobbering copy while the
  // clipboard still holds a prompt the user needs (the app/manual install
  // prompt): reopening the editor shouldn't force overwriting it. Fall back to
  // the copy-only offer (which warns) so copying stays a deliberate choice.
  const canOpen = target != null && canOpenAgent(target) && !clipboardBusy;
  const clip = clipboardBusy ? ` ${pc.dim("(replaces what's on your clipboard now)")}` : '';

  const answer = await p.confirm({
    message: canOpen
      ? `Open ${agentName} and copy the ${label} to your clipboard?${clip}`
      : `Copy the ${label} above to your clipboard?${clip}`,
  });
  if (p.isCancel(answer) || !answer) return;

  try {
    await clipboard.write(prompt);
  } catch {
    p.log.warn('Could not write to the clipboard — copy the prompt above.');
    return;
  }
  onEvent(opts.copiedEvent);

  if (canOpen && target) {
    if ((await openAgent(target)) === 'opened') {
      onEvent(opts.openedEvent, { kind: target.kind });
      p.log.success(
        target.kind === 'terminal'
          ? `Opened a new Terminal window running ${agentName} in ${target.dir} — paste the ${label} ${readyHint}.`
          : `${agentName} is opening — paste the ${label} ${readyHint}.`,
      );
      return;
    }
    p.log.success(`${capitalize(label)} copied — open ${agentName} and paste it ${readyHint}.`);
    return;
  }

  p.log.success(`${capitalize(label)} copied — paste it into ${agentName} ${readyHint}.`);
}
