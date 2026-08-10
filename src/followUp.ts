import * as p from '@clack/prompts';
import clipboard from 'clipboardy';
import pc from 'picocolors';
import { brandPink, readableNoteBody } from './logo.js';

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

  const answer = await p.confirm({
    message: ctx.clipboardBusy
      ? `Copy the follow-up prompt above to your clipboard? ${pc.dim('(replaces what\'s on it now)')}`
      : 'Copy the follow-up prompt above to your clipboard?',
  });
  if (p.isCancel(answer) || !answer) return;

  try {
    await clipboard.write(ctx.prompt);
  } catch {
    p.log.warn('Could not write to the clipboard — copy the prompt above.');
    return;
  }
  ctx.onEvent('phase2_followup_copied');
  p.log.success(`Follow-up prompt copied — paste it into ${ctx.agentName} when you're ready.`);
}
