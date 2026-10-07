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
  'stop and tell me. I likely need to sign in to Subtext in this agent first.',
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
  // The user's to-do list goes in the box at full strength (clack dims note
  // bodies, readableNoteBody undoes that); everything around it stays quiet.
  const steps = [
    ...(ctx.installPending ? [`Let ${ctx.agentName} finish the install`] : []),
    'Restart your dev server',
    'Open the app and click around for a minute or two',
    `Paste the demo prompt into ${ctx.agentName}`,
  ].map((step, i) => `${i + 1}. ${pc.bold(step)}`);
  steps.push(pc.dim('   (approve the Subtext sign-in when asked)'));
  p.note(readableNoteBody(steps.join('\n')), 'Next steps');
  ctx.onEvent('demo_guide_shown', { install_pending: ctx.installPending });

  // Framed and titled so it reads as text for the agent, not more
  // instructions for the user.
  p.note(
    readableNoteBody(DEMO_PROMPT_LINES.map((line) => brandPink(line)).join('\n')),
    ctx.yes ? 'Demo prompt' : "Demo prompt (we'll copy this for you)",
  );

  if (ctx.yes) return;

  await offerCopyAndOpen({
    prompt: DEMO_PROMPT,
    agentName: ctx.agentName,
    target: ctx.openTarget,
    clipboardBusy: ctx.clipboardHoldsInstallPrompt,
    label: 'demo prompt',
    readyHint: "after you've clicked around",
    // Opening the agent before there's a captured session makes the first
    // review come up empty, so the confirm doubles as the "I'm ready" pause.
    confirmHint: "press Enter once you've restarted and clicked around",
    onEvent: ctx.onEvent,
    copiedEvent: 'demo_prompt_copied',
    openedEvent: 'demo_agent_opened',
  });
}
