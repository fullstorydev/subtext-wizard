import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clackStub } from './test/helpers.js';
import type { OpenAgentTarget } from './openAgent.js';

/**
 * The two closing guides. Both run after the install has already succeeded,
 * so neither may throw and neither may turn a finished run into a failure.
 * They also share a rule: the agent-facing prompt prints outside the note,
 * directly above the copy question, because clack anchors the live prompt at
 * the bottom and nothing can render below it.
 */

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const offerCopyAndOpen = vi.hoisted(() =>
  vi.fn<(opts: Record<string, unknown>) => Promise<void>>(async () => undefined),
);
vi.mock('./openAgent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./openAgent.js')>();
  return { ...actual, offerCopyAndOpen };
});

const { DEMO_PROMPT, showDemoGuide } = await import('./demo.js');
const { offerFollowUpPrompt } = await import('./followUp.js');

const onEvent = vi.fn();
const target: OpenAgentTarget = {
  kind: 'terminal',
  name: 'Claude Code',
  binaryPath: '/bin/claude',
  dir: '/work/app',
};

/** The body of the note the guide printed. */
const note = () => String(clack.note.mock.calls[0][0]);
/** Everything printed outside the note. */
const messages = () => clack.log.message.mock.calls.map((c) => String(c[0])).join('\n');
/** The options offerCopyAndOpen was called with. */
const copyOffer = () => offerCopyAndOpen.mock.calls[0][0];

afterEach(() => vi.resetAllMocks());

// ---------------------------------------------------------------------------

describe('showDemoGuide', () => {
  const ctx = (over = {}) => ({ agentName: 'Claude Code', installPending: false, yes: false, onEvent, ...over });

  it('walks through dev server, clicking around, then asking the agent', async () => {
    await showDemoGuide(ctx());

    expect(note()).toMatch(/Start \(or restart\) your local dev server/);
    expect(note()).toMatch(/click around/);
    expect(note()).toContain('Open Claude Code at this project');
  });

  it('leads with completion when the install is confirmed done', async () => {
    await showDemoGuide(ctx({ installPending: false }));
    expect(note()).toContain('Installation complete');
  });

  /**
   * A GUI or manual handoff hasn't run yet, and a terminal run that exited 0
   * without an install marker may have been refused. Either way the guide
   * must not present the snippet as already live.
   */
  it('leads with "once the install finishes" when it is not confirmed', async () => {
    await showDemoGuide(ctx({ installPending: true }));

    expect(note()).toContain('Once the install finishes');
    expect(note()).not.toContain('Installation complete');
  });

  it('warns that the agent will ask the user to sign in to Subtext', async () => {
    await showDemoGuide(ctx());
    expect(note()).toMatch(/sign in to Subtext/);
  });

  it('prints the demo prompt outside the note, next to the copy question', async () => {
    await showDemoGuide(ctx());

    expect(messages()).toContain('I just set up Subtext session capture');
    expect(note()).not.toContain('I just set up Subtext session capture');
  });

  // Some terminal agents submit on a pasted newline, so the clipboard gets
  // one line even though the note shows several.
  it('hands over a single-line prompt', async () => {
    expect(DEMO_PROMPT).not.toContain('\n');
    await showDemoGuide(ctx());
    expect(copyOffer().prompt).toBe(DEMO_PROMPT);
  });

  it('offers to open the harness it knows about', async () => {
    await showDemoGuide(ctx({ openTarget: target }));

    expect(copyOffer()).toMatchObject({
      target,
      agentName: 'Claude Code',
      label: 'demo prompt',
      copiedEvent: 'demo_prompt_copied',
      openedEvent: 'demo_agent_opened',
    });
  });

  it('passes the clipboard warning through from a handoff', async () => {
    await showDemoGuide(ctx({ clipboardHoldsInstallPrompt: true }));
    expect(copyOffer().clipboardBusy).toBe(true);
  });

  it('shows the guide but skips the interactive offer under --yes', async () => {
    await showDemoGuide(ctx({ yes: true }));

    expect(clack.note).toHaveBeenCalled();
    expect(offerCopyAndOpen).not.toHaveBeenCalled();
  });

  it('records that the guide was shown', async () => {
    await showDemoGuide(ctx({ installPending: true }));
    expect(onEvent).toHaveBeenCalledWith('demo_guide_shown', { install_pending: true });
  });

  /**
   * demo.ts's header says the guide "never throws". It has no try/catch, so
   * that guarantee actually lives in offerCopyAndOpen, which swallows
   * clipboard and launch failures itself. Recording the real behaviour here
   * so the assumption is visible rather than implied.
   */
  it('relies on offerCopyAndOpen for its no-throw guarantee', async () => {
    offerCopyAndOpen.mockRejectedValueOnce(new Error('clipboard exploded'));
    await expect(showDemoGuide(ctx())).rejects.toThrow('clipboard exploded');
  });
});

// ---------------------------------------------------------------------------

describe('offerFollowUpPrompt', () => {
  const ctx = (over = {}) => ({
    prompt: 'Finish setting up Subtext: identify users…',
    agentName: 'Cursor',
    yes: false,
    onEvent,
    ...over,
  });

  it('frames enrichment as step 2 of 2 and lists what it does', async () => {
    await offerFollowUpPrompt(ctx());

    expect(clack.note.mock.calls[0][1]).toBe('Finish setup (step 2 of 2)');
    expect(note()).toMatch(/identifies your users/);
    expect(note()).toMatch(/masks sensitive data/);
    expect(note()).toContain('Cursor');
  });

  it('prints the prompt outside the note', async () => {
    await offerFollowUpPrompt(ctx());

    expect(messages()).toContain('Finish setting up Subtext');
    expect(note()).not.toContain('Finish setting up Subtext');
  });

  it('offers it as the follow-up prompt', async () => {
    await offerFollowUpPrompt(ctx({ openTarget: target, clipboardBusy: true }));

    expect(copyOffer()).toMatchObject({
      target,
      clipboardBusy: true,
      label: 'follow-up prompt',
      copiedEvent: 'phase2_followup_copied',
      openedEvent: 'phase2_followup_opened',
    });
  });

  it('skips the interactive offer under --yes', async () => {
    await offerFollowUpPrompt(ctx({ yes: true }));

    expect(clack.note).toHaveBeenCalled();
    expect(offerCopyAndOpen).not.toHaveBeenCalled();
  });

  it('records that the follow-up was offered', async () => {
    await offerFollowUpPrompt(ctx());
    expect(onEvent).toHaveBeenCalledWith('phase2_followup_offered');
  });
});
