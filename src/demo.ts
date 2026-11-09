import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { SubtextAuth } from './auth.js';
import { pollFirstEvent, type FirstEventResult } from './firstEvent.js';
import { brandPink, pinkShade } from './logo.js';

/**
 * The wizard's closing check: tell the user to run their dev server and click
 * around, then watch for the org's first captured session right here in the
 * terminal. Never throws, because everything before it already succeeded and
 * a cancel here must not turn a finished install into a reported failure.
 */

export interface DemoGuideContext {
  auth: SubtextAuth;
  /** True when the install isn't confirmed done: the prompt still has to run
   * (manual copy / GUI handoff), or a terminal run ended without the agent's
   * install-success marker. */
  installPending: boolean;
  /** --yes (CI): show the steps, don't block on a browser session. */
  yes: boolean;
  /** --mock / --print-prompt: there's no real org to poll. */
  dryRun: boolean;
  onEvent: (event: string, properties?: Record<string, unknown>) => void;
  /** Test seam. */
  poll?: typeof pollFirstEvent;
}

const TITLE = 'First run';

export async function showDemoGuide(ctx: DemoGuideContext): Promise<void> {
  const lead = ctx.installPending ? [] : ["Installation complete. Let's check that capture works.", ''];
  const steps = [
    ...lead,
    pc.bold('1. Start (or restart) your local dev server so the new snippet is live.'),
    pc.bold('2. Open the app in your browser and click around for a minute.'),
  ];
  ctx.onEvent('demo_guide_shown', { install_pending: ctx.installPending });

  const watching = !ctx.yes && !ctx.dryRun;
  if (!watching || !process.stdout.isTTY) {
    const tail = watching ? ['', 'Waiting for your first session…'] : [];
    process.stdout.write(renderBox(TITLE, [...steps, ...tail]).join('\n') + '\n');
    if (!watching) return;
  }

  const result = await waitForFirstSession(ctx, steps);
  ctx.onEvent('first_event_result', { status: result.status });
  switch (result.status) {
    case 'received':
      p.log.success(
        `${pc.green('Subtext is capturing sessions.')} Ask your coding agent to review your latest session any time.`,
      );
      return;
    case 'timeout':
      p.log.warn(
        "No session yet. Make sure the dev server picked up the snippet and you've loaded a page; it can take a minute or two to show up.",
      );
      return;
    case 'unavailable':
      p.log.warn(
        `Couldn't check for sessions from here (${result.reason}). Your sessions will still show up in Subtext once you've clicked around.`,
      );
      return;
    case 'aborted':
      p.log.info('Skipped waiting for a session.');
      return;
  }
}

async function waitForFirstSession(
  ctx: DemoGuideContext,
  steps: string[],
): Promise<FirstEventResult> {
  const poll = ctx.poll ?? pollFirstEvent;
  for (;;) {
    const result = await pollInBox(ctx.auth, poll, steps);
    if (result.status !== 'timeout') return result;
    const again = await p.confirm({ message: 'Still no session. Keep waiting?', initialValue: true });
    if (p.isCancel(again) || !again) return result;
  }
}

/**
 * Draws the instructions box with a live watcher at the bottom, redrawn in
 * place every frame. clack's note() is print-once, so the box is ours, drawn
 * to match clack's note style.
 */
async function pollInBox(
  auth: SubtextAuth,
  poll: typeof pollFirstEvent,
  steps: string[],
): Promise<FirstEventResult> {
  const out = process.stdout;
  const controller = new AbortController();
  // Ctrl+C skips the wait instead of killing the wizard, so phase 2 still runs.
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);
  if (!out.isTTY) {
    try {
      return await poll(auth, { signal: controller.signal });
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  }

  // Raw mode so typed keys aren't echoed into the frame; an echoed Enter adds a
  // line and the cursor-up redraw would then land one row off. Raw mode also
  // swallows SIGINT, so Ctrl+C is caught as a byte here instead.
  const stdin = process.stdin;
  const canRaw = stdin.isTTY && typeof stdin.setRawMode === 'function';
  const onKey = (data: Buffer) => {
    if (data.includes(0x03)) controller.abort();
  };
  if (canRaw) {
    stdin.setRawMode(true);
    stdin.on('data', onKey);
    stdin.resume();
  }
  const restoreCursor = () => {
    out.write('\x1b[?25h');
    if (canRaw) {
      stdin.removeListener('data', onKey);
      stdin.setRawMode(false);
      stdin.pause();
    }
  };
  process.once('exit', restoreCursor);
  const started = Date.now();
  let frame = 0;
  let drawnLines = 0;
  const draw = (watcher: string[]) => {
    const lines = renderBox(TITLE, [...steps, '', ...watcher]);
    // renderBox never exceeds the terminal width, so no line wraps and the
    // count is exact. A resize mid-wait can still leave a stray frame behind.
    if (drawnLines > 0) out.write(`\x1b[${drawnLines}A\x1b[0J`);
    out.write(lines.join('\n') + '\n');
    drawnLines = lines.length;
  };

  out.write('\x1b[?25l');
  const timer = setInterval(() => draw(watcherFrame(frame++, Date.now() - started)), 80);
  draw(watcherFrame(frame++, 0));
  try {
    const result = await poll(auth, { signal: controller.signal });
    clearInterval(timer);
    draw(finalFrame(result, Date.now() - started));
    return result;
  } finally {
    clearInterval(timer);
    restoreCursor();
    process.removeListener('exit', restoreCursor);
    process.removeListener('SIGINT', onSigint);
  }
}

const SPINNER = ['◐', '◓', '◑', '◒'];

function watcherFrame(frame: number, elapsedMs: number): string[] {
  const width = innerWidth() - 2;
  const dots = '.'.repeat(Math.floor(frame / 6) % 4).padEnd(3);
  const spin = brandPink(SPINNER[Math.floor(frame / 3) % SPINNER.length]);
  const heading = `${spin}  ${pc.bold(brandPink(`Waiting for your first session${dots}`))}`;
  return [
    padBetween(heading, pc.dim(formatElapsed(elapsedMs)), width),
    '',
    sweepBar(frame, width),
    '',
    pc.dim('Sessions can take a minute to appear. Ctrl+C to skip.'),
  ];
}

function finalFrame(result: FirstEventResult, elapsedMs: number): string[] {
  const width = innerWidth() - 2;
  const time = pc.dim(formatElapsed(elapsedMs));
  switch (result.status) {
    case 'received':
      return [
        padBetween(`${pc.green('✔')}  ${pc.bold(pc.green('First session captured!'))}`, time, width),
        '',
        pc.green('━'.repeat(width)),
      ];
    case 'aborted':
      return [padBetween(`${pc.yellow('■')}  Stopped waiting.`, time, width)];
    case 'timeout':
      return [padBetween(`${pc.yellow('▲')}  No session yet.`, time, width)];
    case 'unavailable':
      return [padBetween(`${pc.yellow('▲')}  Couldn't check for sessions.`, time, width)];
  }
}

/** A pink comet sweeping back and forth across a dim track. */
function sweepBar(frame: number, width: number): string {
  const tail = Math.max(6, Math.floor(width / 5));
  const span = width + tail;
  const t = frame % (span * 2);
  const forward = t < span;
  const head = forward ? t : span * 2 - t;
  let bar = '';
  for (let i = 0; i < width; i++) {
    const dist = forward ? head - i : i - (head - tail);
    bar += dist >= 0 && dist < tail ? pinkShade('━', 1 - dist / tail) : pc.dim('─');
  }
  return bar;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visibleLength = (s: string) => s.replace(ANSI, '').length;

function innerWidth(): number {
  const columns = process.stdout.columns || 80;
  return Math.max(30, Math.min(76, columns - 4));
}

function padBetween(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return left + ' '.repeat(gap) + right;
}

function wrap(line: string, width: number): string[] {
  if (visibleLength(line) <= width) return [line];
  const plain = line.replace(ANSI, '');
  if (plain !== line) {
    // Re-apply the line's leading style to each wrapped piece so bold steps stay bold.
    const lead = line.match(/^(?:\x1b\[[0-9;]*m)+/)?.[0] ?? '';
    return wrap(plain, width).map((piece) => `${lead}${piece}\x1b[0m`);
  }
  const lines: string[] = [];
  let current = '';
  for (const word of plain.split(' ')) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = `   ${word}`;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Same shape clack's note() draws, so it sits in the timeline seamlessly. */
function renderBox(title: string, body: string[]): string[] {
  const inner = innerWidth();
  const bar = pc.gray('│');
  const rows = body.flatMap((line) => wrap(line, inner - 2));
  const titleRule = pc.gray(`${'─'.repeat(Math.max(1, inner - title.length - 1))}╮`);
  const blank = `${bar}${' '.repeat(inner + 2)}${bar}`;
  return [
    bar,
    `${pc.green('◇')}  ${pc.reset(title)} ${titleRule}`,
    blank,
    ...rows.map((row) => `${bar}  ${row}${' '.repeat(Math.max(0, inner - visibleLength(row)))}${bar}`),
    blank,
    pc.gray(`├${'─'.repeat(inner + 2)}╯`),
  ];
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
