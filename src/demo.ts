import * as p from '@clack/prompts';
import clipboard from 'clipboardy';
import pc from 'picocolors';
import { brandPurple } from './logo.js';

/**
 * The wizard's closing section: a short "see it in action" guide. Capture is
 * now wired into the app, so the user can watch the loop work end-to-end —
 * run the local dev server, click around to record a session, then ask the
 * same agent they just set up to review that session through the Subtext
 * plugin. Informational plus an optional clipboard copy; it never throws,
 * because everything before it has already succeeded and a cancel here must
 * not turn a finished install into a reported failure.
 */

/** Kept as sentences so the note can show one per line while the clipboard
 * gets a single line — some terminal agents submit on a pasted newline. */
const DEMO_PROMPT_LINES = [
  'I just set up Subtext session capture in this app and clicked around my',
  'local dev build. Use the Subtext tools to find my most recent captured',
  'session and walk me through it: which pages I visited, what I interacted',
  'with, and anything that looked broken or confusing along the way.',
];

export const DEMO_PROMPT = DEMO_PROMPT_LINES.join(' ');

export interface DemoGuideContext {
  /** Harness display name ("Claude Code"), or "your coding agent" when the
   * user took the raw prompt and we never learned which one. */
  agentName: string;
  /** True when the install isn't confirmed done — the prompt still has to run
   * (manual copy / GUI handoff), or a terminal run ended without the agent's
   * install-success marker. The guide then leads with "once the install
   * finishes" instead of presenting the snippet as already live. */
  installPending: boolean;
  /** Manual and GUI handoff paths: the install prompt currently occupies the
   * clipboard, so copying the demo prompt now would clobber it. Warn in the
   * confirm. */
  clipboardHoldsInstallPrompt?: boolean;
  /** --yes (CI): show the guide, skip the interactive copy offer. */
  yes: boolean;
  onEvent: (event: string, properties?: Record<string, unknown>) => void;
}

export async function showDemoGuide(ctx: DemoGuideContext): Promise<void> {
  const lead = ctx.installPending
    ? `Once the install finishes, make sure everything works.`
    : `Installation complete — let's make sure everything works.`;
  // clack renders note bodies dimmed; pc.reset per line undoes that (the same
  // escape clack itself uses for note titles) so everything reads at full
  // strength. The prompt is set apart by color — brand purple is the agent's
  // text, plain is the human's steps. Only the closing aside stays dim, and
  // re-dims inside the reset.
  p.note(
    [
      lead,
      pc.bold('Follow these steps:'),
      '',
      '1. Start (or restart) your local dev server so the new snippet is live.',
      '2. Open the app in your browser and click around for a minute —',
      '   Subtext is capturing your session as you go.',
      `3. Open ${ctx.agentName} at this project and paste in the demo prompt`,
      '   below — that part is the agent\'s job:',
      '',
      ...DEMO_PROMPT_LINES.map((line) => `   ${brandPurple(line)}`),
      '',
      pc.dim('Captured sessions can take a minute or two to show up.'),
    ]
      .map((line) => pc.reset(line))
      .join('\n'),
    'First run',
  );
  ctx.onEvent('demo_guide_shown', { install_pending: ctx.installPending });

  if (ctx.yes) return;

  const answer = await p.confirm({
    message: ctx.clipboardHoldsInstallPrompt
      ? `Copy the demo prompt to your clipboard? ${pc.dim(
          '(replaces the install prompt currently on it)',
        )}`
      : 'Copy the demo prompt to your clipboard?',
  });
  if (p.isCancel(answer) || !answer) return;

  try {
    await clipboard.write(DEMO_PROMPT);
  } catch {
    p.log.warn('Could not write to the clipboard — copy the prompt from the note above.');
    return;
  }
  ctx.onEvent('demo_prompt_copied');
  p.log.success(`Demo prompt copied — paste it into ${ctx.agentName} after you've clicked around.`);
}
