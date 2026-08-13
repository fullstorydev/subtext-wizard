import * as p from '@clack/prompts';
import pc from 'picocolors';
import { brandPink, readableNoteBody } from './logo.js';
import { offerCopyAndOpen, type OpenAgentTarget } from './openAgent.js';

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
  'If the Subtext tools return an authentication or authorization error,',
  'stop and tell me — I likely need to sign in to Subtext in this agent first.',
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
  /** The harness to offer to open at the demo hand-off, when we know it (not
   * the manual path). Copies the prompt and brings the agent up alongside it. */
  openTarget?: OpenAgentTarget;
  onEvent: (event: string, properties?: Record<string, unknown>) => void;
}

export async function showDemoGuide(ctx: DemoGuideContext): Promise<void> {
  const lead = ctx.installPending
    ? `Once the install finishes, make sure everything works.`
    : `Installation complete — let's make sure everything works.`;
  // clack renders note bodies dimmed; readableNoteBody resets per line so the
  // steps read at full strength. The demo prompt itself is NOT in the box — it
  // prints as a pink block in the timeline next to the copy action below, so
  // it's clear which text the "copy?" question refers to.
  p.note(
    readableNoteBody(
      [
        lead,
        pc.bold('Follow these steps:'),
        '',
        '1. Start (or restart) your local dev server so the new snippet is live.',
        '2. Open the app in your browser and click around for a minute —',
        '   Subtext is capturing your session as you go.',
        `3. Open ${ctx.agentName} at this project and paste in the demo prompt`,
        '   shown below — that part is the agent\'s job.',
        '   The first time it reaches for a Subtext tool, your agent will ask you',
        '   to sign in to Subtext — approve it so the tools can read your sessions.',
        '',
        pc.dim('Captured sessions can take a minute or two to show up.'),
      ].join('\n'),
    ),
    'First run',
  );
  ctx.onEvent('demo_guide_shown', { install_pending: ctx.installPending });

  // The agent-facing prompt, in brand pink, as its own timeline block right
  // above the copy question — clack anchors the active prompt at the bottom,
  // so the prompt has to sit just before it (nothing can render below a live
  // question). This keeps it out of the box and directly beside the action.
  p.log.message(DEMO_PROMPT_LINES.map((line) => brandPink(line)).join('\n'));

  if (ctx.yes) return;

  await offerCopyAndOpen({
    prompt: DEMO_PROMPT,
    agentName: ctx.agentName,
    target: ctx.openTarget,
    clipboardBusy: ctx.clipboardHoldsInstallPrompt,
    label: 'demo prompt',
    readyHint: "after you've clicked around",
    onEvent: ctx.onEvent,
    copiedEvent: 'demo_prompt_copied',
    openedEvent: 'demo_agent_opened',
  });
}
