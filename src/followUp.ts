import * as p from '@clack/prompts';
import { brandPink, readableNoteBody } from './logo.js';
import { offerCopyAndOpen, type OpenAgentTarget } from './openAgent.js';

/**
 * The second half of setup, offered as a copyable prompt rather than a driven
 * run. Terminal harnesses get a real second hand-off (the wizard re-launches
 * the agent), but app and manual hand-offs never return control to the wizard —
 * it can't drive them a second time — so their enrichment step (identify users,
 * link analytics, mask PII) is handed over as a prompt the user pastes into
 * their agent whenever they're ready. Informational plus an optional clipboard
 * copy; it never throws, because the snippet install has already succeeded and
 * a cancel here must not turn a finished install into a reported failure.
 */

export interface FollowUpContext {
  /** The phase-2 (enrich) prompt to hand over. */
  prompt: string;
  /** Harness display name ("Cursor"), or "your coding agent" for the manual path. */
  agentName: string;
  /** The clipboard currently holds another prompt (install/demo), so copying
   * now would clobber it — warn in the confirm. */
  clipboardBusy?: boolean;
  /** --yes (CI): show the note, skip the interactive copy offer. */
  yes: boolean;
  /** The harness to offer to open at the follow-up hand-off, when we know it
   * (not the manual path). Copies the prompt and brings the agent up too. */
  openTarget?: OpenAgentTarget;
  onEvent: (event: string, properties?: Record<string, unknown>) => void;
}

export async function offerFollowUpPrompt(ctx: FollowUpContext): Promise<void> {
  p.note(
    readableNoteBody(
      [
        'The snippet install is step 1 of 2. Once it finishes, complete setup by',
        `pasting the prompt shown below into ${ctx.agentName} at this project — it`,
        'identifies your users, links the session URL into your analytics tools,',
        'and masks sensitive data.',
      ].join('\n'),
    ),
    'Finish setup (step 2 of 2)',
  );
  ctx.onEvent('phase2_followup_offered');

  // The prompt prints as a pink block in the timeline (outside the box) right
  // above the copy question — clack anchors the active prompt at the bottom,
  // so nothing can render below a live question; placing it just before keeps
  // it out of the box and directly beside the action.
  p.log.message(
    ctx.prompt
      .trim()
      .split('\n')
      .map((line) => brandPink(line))
      .join('\n'),
  );

  if (ctx.yes) return;

  await offerCopyAndOpen({
    prompt: ctx.prompt,
    agentName: ctx.agentName,
    target: ctx.openTarget,
    clipboardBusy: ctx.clipboardBusy,
    label: 'follow-up prompt',
    readyHint: "when you're ready",
    onEvent: ctx.onEvent,
    copiedEvent: 'phase2_followup_copied',
    openedEvent: 'phase2_followup_opened',
  });
}
