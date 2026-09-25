import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clackStub, makeOptions } from './test/helpers.js';
import type { StepMarker } from './agents/telemetry-marker.js';
import type { DetectedAgent, LaunchContext, LaunchResult } from './agents/types.js';
import type { SubtextAuth } from './auth.js';
import type { Region, WizardOptions } from './config.js';
import type { DemoGuideContext } from './demo.js';
import type { FollowUpContext } from './followUp.js';
import type { IntegrationSelection } from './integrations.js';
import type { EnrichPromptInput, SnippetPromptInput } from './prompt/build.js';
import type { PromptReviewChoices } from './promptReview.js';
import type { WorkflowEventMetadata, WorkflowOutcome, WorkflowStep } from './telemetry.js';

type OnEvent = (event: string, properties?: Record<string, unknown>) => void;

/**
 * Every collaborator is mocked: this is about the branch decisions and the
 * funnel, not the copy. Three properties carry the chunk — who owns
 * telemetry on each path, that --print-prompt touches nothing, and that
 * nothing after the snippet install can turn a finished run into a failure.
 */

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const m = vi.hoisted(() => ({
  telemetry: {
    authorize: vi.fn<(endpoint: string, token: string, scheme?: 'Bearer' | 'Basic') => void>(),
    step: vi.fn<(s: WorkflowStep, o?: WorkflowOutcome, meta?: WorkflowEventMetadata) => void>(),
    note: vi.fn<(event: string, properties?: Record<string, unknown>) => void>(),
    finish: vi.fn<(outcome: WorkflowOutcome, meta?: WorkflowEventMetadata) => void>(),
    flush: vi.fn<() => Promise<void>>(async () => undefined),
  },
  authenticate:
    vi.fn<(options: WizardOptions, openBrowser?: boolean) => Promise<SubtextAuth>>(),
  fetchCaptureSnippet: vi.fn<() => Promise<string>>(),
  detectAgents: vi.fn<() => Promise<DetectedAgent[]>>(),
  chooseAgent: vi.fn<() => Promise<DetectedAgent | 'manual'>>(),
  guidePluginSetup: vi.fn<() => Promise<boolean>>(),
  offerPluginSetup:
    vi.fn<
      (
        chosen: DetectedAgent | 'manual',
        region: Region,
        options: WizardOptions,
        onEvent: OnEvent,
        preConsent?: boolean,
      ) => Promise<void>
    >(async () => undefined),
  offerPromptReview:
    vi.fn<(prompt: string, choices: PromptReviewChoices) => Promise<{ reviewed: boolean }>>(),
  showDemoGuide: vi.fn<(ctx: DemoGuideContext) => Promise<void>>(async () => undefined),
  offerFollowUpPrompt: vi.fn<(ctx: FollowUpContext) => Promise<void>>(async () => undefined),
  selectIntegrations: vi.fn<() => Promise<IntegrationSelection>>(),
  buildSnippetPrompt: vi.fn<(input: SnippetPromptInput) => string>(),
  buildEnrichPrompt: vi.fn<(input: EnrichPromptInput) => string>(),
  clipboardWrite: vi.fn<(text: string) => Promise<void>>(async () => undefined),
  showLogo: vi.fn<() => Promise<void>>(async () => undefined),
}));

// A constructor returning an object replaces `this`, so every `new
// Telemetry(...)` in run.ts hands back the same spy set.
vi.mock('./telemetry.js', () => ({
  Telemetry: class {
    constructor() {
      return m.telemetry as never;
    }
  },
}));
vi.mock('./auth.js', () => ({ authenticate: m.authenticate }));
vi.mock('./snippet.js', () => ({ fetchCaptureSnippet: m.fetchCaptureSnippet }));
vi.mock('./plugin.js', () => ({ guidePluginSetup: m.guidePluginSetup }));
vi.mock('./pluginSetup.js', () => ({ offerPluginSetup: m.offerPluginSetup }));
vi.mock('./promptReview.js', () => ({ offerPromptReview: m.offerPromptReview }));
vi.mock('./demo.js', () => ({ showDemoGuide: m.showDemoGuide }));
vi.mock('./followUp.js', () => ({ offerFollowUpPrompt: m.offerFollowUpPrompt }));
vi.mock('./prompt/build.js', () => ({
  buildSnippetPrompt: m.buildSnippetPrompt,
  buildEnrichPrompt: m.buildEnrichPrompt,
}));
vi.mock('clipboardy', () => ({ default: { write: m.clipboardWrite } }));
vi.mock('./agents/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agents/index.js')>();
  return { ...actual, detectAgents: m.detectAgents, chooseAgent: m.chooseAgent };
});
// CancelledError must stay the real class — run.ts branches on instanceof.
vi.mock('./integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integrations.js')>();
  return { ...actual, selectIntegrations: m.selectIntegrations };
});
vi.mock('./logo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logo.js')>();
  return { ...actual, showLogo: m.showLogo };
});

const { MANUAL_CHOICE } = await import('./agents/index.js');
const { CancelledError } = await import('./integrations.js');
const { runWizard } = await import('./run.js');

// ---------------------------------------------------------------------------

const AUTH: SubtextAuth = {
  accessToken: 'tok',
  authScheme: 'Bearer',
  orgId: 'o-1G1-na1',
  region: 'us',
};

/** A detected agent whose launch the test controls. */
function harness(
  kind: 'terminal' | 'app',
  id = kind === 'terminal' ? 'claude-code' : 'cursor',
  launch: (ctx: LaunchContext) => Promise<LaunchResult> = async () => ({
    mode: kind === 'terminal' ? 'ran' : 'handoff',
    exitCode: 0,
  }),
) {
  return {
    definition: { id, name: id, kind, autonomy: 'auto-accepting file edits', launch: vi.fn(launch) },
    binaryPath: `/bin/${id}`,
  } as unknown as DetectedAgent & { definition: { launch: ReturnType<typeof vi.fn> } };
}

/** A terminal agent that reports a successful install on every launch. */
const installing = (launch?: (ctx: LaunchContext) => Promise<LaunchResult>) =>
  harness('terminal', 'claude-code', async (ctx) => {
    ctx.onTelemetry?.({ step: 'install', outcome: 'success' });
    return launch ? launch(ctx) : { mode: 'ran', exitCode: 0 };
  });

/** Run the wizard with an agent already chosen. */
function wizard(
  chosen: DetectedAgent | typeof MANUAL_CHOICE,
  overrides: Parameters<typeof makeOptions>[0] = {},
) {
  m.chooseAgent.mockResolvedValue(chosen);
  // apiKey skips the browser-consent confirm; yes skips the optional gates.
  return runWizard(makeOptions({ apiKey: 'tok', yes: true, telemetry: true, ...overrides }));
}

/** Every telemetry.step call as [step, outcome]. */
const steps = () => m.telemetry.step.mock.calls.map(([s, o]) => [s, o ?? null]);
const stepNames = () => m.telemetry.step.mock.calls.map(([s]) => s);
/** The telemetry transport chosen for the phase-1 prompt. */
const promptTelemetry = () => m.buildSnippetPrompt.mock.calls[0][0].telemetry;
const promptMode = () => m.buildSnippetPrompt.mock.calls[0][0].mode;

beforeEach(() => {
  m.authenticate.mockResolvedValue(AUTH);
  m.fetchCaptureSnippet.mockResolvedValue('<script>snippet</script>');
  m.detectAgents.mockResolvedValue([]);
  m.guidePluginSetup.mockResolvedValue(false);
  m.offerPromptReview.mockResolvedValue({ reviewed: false });
  m.selectIntegrations.mockResolvedValue({ integrations: [], other: [] });
  m.buildSnippetPrompt.mockReturnValue('SNIPPET_PROMPT');
  m.buildEnrichPrompt.mockReturnValue('ENRICH_PROMPT');
  clack.confirm.mockResolvedValue(true);
});

afterEach(() => vi.resetAllMocks());

// ---------------------------------------------------------------------------

/**
 * A credential never reaches the agent's process — an install subprocess
 * could read it — so terminal runs have the agent print markers the wizard
 * forwards with its own token. A GUI handoff can only self-report when the
 * plugin is actually there.
 */
describe('who owns telemetry', () => {
  it('has a terminal agent print stdout markers', async () => {
    await wizard(harness('terminal'));

    expect(promptTelemetry()).toBe('stdout');
    expect(promptMode()).toBe('headless');
  });

  it('lets a GUI agent log over MCP once the plugin is set up', async () => {
    m.guidePluginSetup.mockResolvedValue(true);

    await wizard(harness('app'));

    expect(promptTelemetry()).toBe('mcp');
    expect(promptMode()).toBe('interactive');
  });

  // Without the plugin the agent has no tool to log with, so the prompt must
  // not ask — the wizard reports the start itself instead.
  it('gives a GUI agent without the plugin no telemetry section', async () => {
    m.guidePluginSetup.mockResolvedValue(false);

    await wizard(harness('app'));

    expect(promptTelemetry()).toBe('none');
  });

  it('gives the manual handoff no telemetry section', async () => {
    await wizard(MANUAL_CHOICE);
    expect(promptTelemetry()).toBe('none');
  });

  it.each([
    ['telemetry is off', { telemetry: false }],
    ['the run is mocked', { mock: true }],
  ])('gives no telemetry section when %s', async (_label, overrides) => {
    await wizard(harness('terminal'), overrides);
    expect(promptTelemetry()).toBe('none');
  });

  it('only authorizes delivery for a real, consented run', async () => {
    await wizard(harness('terminal'));
    expect(m.telemetry.authorize).toHaveBeenCalledWith(
      'https://api.fullstory.com/subtext/telemetry',
      'tok',
      'Bearer',
    );

    vi.clearAllMocks();
    await wizard(harness('terminal'), { mock: true });
    expect(m.telemetry.authorize).not.toHaveBeenCalled();
  });
});

/** Exactly one funnel entry per run, from whoever owns it. */
describe('the start event', () => {
  it('is sent once by the wizard for a terminal run', async () => {
    await wizard(harness('terminal'));
    expect(stepNames().filter((s) => s === 'start')).toEqual(['start']);
  });

  it('is sent once for a manual handoff', async () => {
    await wizard(MANUAL_CHOICE);
    expect(m.telemetry.step).toHaveBeenCalledWith('start', undefined, { harness: 'manual' });
  });

  it('is sent by the wizard for a GUI handoff with no plugin', async () => {
    m.guidePluginSetup.mockResolvedValue(false);
    await wizard(harness('app'));
    expect(stepNames()).toContain('start');
  });

  // With the plugin the agent logs its own richer start (harness + model),
  // so the wizard staying quiet is what prevents double-counting.
  it('is left to the agent for a GUI handoff with the plugin', async () => {
    m.guidePluginSetup.mockResolvedValue(true);
    await wizard(harness('app'));
    expect(stepNames()).not.toContain('start');
  });
});

// ---------------------------------------------------------------------------

/**
 * --print-prompt is a testing aid. It must not install anything, launch
 * anything, or put runs that never began into the onboarding funnel.
 */
describe('--print-prompt', () => {
  it('never spawns a terminal agent', async () => {
    const agent = harness('terminal');

    const code = await wizard(agent, { printPrompt: true });

    expect(code).toBe(0);
    expect(agent.definition.launch).not.toHaveBeenCalled();
  });

  it('never opens a GUI app', async () => {
    const agent = harness('app');
    await wizard(agent, { printPrompt: true });
    expect(agent.definition.launch).not.toHaveBeenCalled();
  });

  /**
   * The guarantee is "nothing reaches the funnel", and the mechanism is that
   * telemetry is never authorized — an unauthorized Telemetry drops every
   * event because there is nowhere to send it. step() is still called; it
   * just cannot deliver.
   */
  it('never authorizes telemetry, so no event can be delivered', async () => {
    await wizard(harness('terminal'), { printPrompt: true });
    expect(m.telemetry.authorize).not.toHaveBeenCalled();
  });

  it('skips plugin setup, which would spawn the agent CLI', async () => {
    await wizard(harness('terminal'), { printPrompt: true });
    expect(m.offerPluginSetup).not.toHaveBeenCalled();
  });

  it('withholds the open-agent offer from the demo guide', async () => {
    await wizard(harness('terminal'), { printPrompt: true });
    expect(m.showDemoGuide.mock.calls[0][0].openTarget).toBeUndefined();
  });

  it('still prints both prompts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await wizard(harness('terminal'), { printPrompt: true });

    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('SNIPPET_PROMPT');
    expect(printed).toContain('ENRICH_PROMPT');
  });
});

// ---------------------------------------------------------------------------

describe('the manual handoff', () => {
  it('copies the prompt and offers the follow-up', async () => {
    const code = await wizard(MANUAL_CHOICE);

    expect(code).toBe(0);
    expect(m.clipboardWrite).toHaveBeenCalledWith('SNIPPET_PROMPT');
    expect(m.offerPluginSetup).toHaveBeenCalledWith(
      MANUAL_CHOICE,
      'us',
      expect.anything(),
      expect.anything(),
    );
    expect(m.offerFollowUpPrompt.mock.calls[0][0].prompt).toBe('ENRICH_PROMPT');
  });

  it('prints the prompt inline when the clipboard fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    m.clipboardWrite.mockRejectedValueOnce(new Error('no clipboard'));

    await wizard(MANUAL_CHOICE);

    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('SNIPPET_PROMPT');
  });
});

describe('the GUI handoff', () => {
  it('launches once with the snippet prompt and finishes cleanly', async () => {
    const agent = harness('app');

    const code = await wizard(agent);

    expect(code).toBe(0);
    expect(agent.definition.launch).toHaveBeenCalledOnce();
    expect(agent.definition.launch.mock.calls[0][0].prompt).toBe('SNIPPET_PROMPT');
  });

  // The wizard cannot drive a GUI app twice, so phase 2 is a copyable prompt.
  it('hands phase 2 over as a follow-up rather than a second launch', async () => {
    const agent = harness('app');

    await wizard(agent);

    expect(agent.definition.launch).toHaveBeenCalledOnce();
    expect(m.offerFollowUpPrompt).toHaveBeenCalledOnce();
    expect(m.buildEnrichPrompt.mock.calls[0][0]).toMatchObject({
      mode: 'interactive',
      telemetry: 'none',
    });
  });
});

// ---------------------------------------------------------------------------

describe('the terminal run', () => {
  it('drives both phases and closes the funnel once', async () => {
    const agent = harness('terminal');

    const code = await wizard(agent);

    expect(code).toBe(0);
    expect(agent.definition.launch.mock.calls.map((c) => c[0].prompt)).toEqual([
      'SNIPPET_PROMPT',
      'ENRICH_PROMPT',
    ]);
    expect(stepNames().filter((s) => s === 'complete')).toHaveLength(1);
  });

  it('runs the enrich pass headlessly with the same transport', async () => {
    await wizard(harness('terminal'));
    expect(m.buildEnrichPrompt.mock.calls[0][0]).toMatchObject({
      mode: 'headless',
      telemetry: 'stdout',
    });
  });

  describe('when phase 1 fails', () => {
    const failing = () =>
      harness('terminal', 'claude-code', async () => ({ mode: 'ran', exitCode: 2 }));

    it('returns the agent’s exit code and closes the funnel as failed', async () => {
      const code = await wizard(failing());

      expect(code).toBe(2);
      expect(steps()).toContainEqual(['complete', 'fail']);
    });

    it('does not set up the plugin or offer phase 2', async () => {
      await wizard(failing());

      expect(m.offerPluginSetup).not.toHaveBeenCalled();
      expect(m.buildEnrichPrompt).not.toHaveBeenCalled();
    });
  });

  /**
   * Exit 0 only proves the CLI ran to completion — codex and gemini exit 0
   * even when the model refused the install — so success additionally
   * requires the agent's own install marker.
   */
  describe('deciding whether the install actually happened', () => {
    const reporting = (markers: StepMarker[]) =>
      harness('terminal', 'claude-code', async (ctx) => {
        for (const marker of markers) ctx.onTelemetry?.(marker);
        return { mode: 'ran', exitCode: 0 };
      });

    it('is a success when the agent reported the install', async () => {
      await wizard(reporting([{ step: 'install', outcome: 'success' }]));
      expect(steps()).toContainEqual(['complete', 'success']);
    });

    it('is partial when exit 0 arrives with no install marker', async () => {
      await wizard(reporting([{ step: 'explore', outcome: 'success' }]));
      expect(steps()).toContainEqual(['complete', 'partial']);
    });

    it('is partial when the agent reported the install as failed', async () => {
      await wizard(reporting([{ step: 'install', outcome: 'fail' }]));
      expect(steps()).toContainEqual(['complete', 'partial']);
    });

    // With no marker instructions in the prompt, the exit code is all we have.
    it('trusts exit 0 when the prompt carried no telemetry section', async () => {
      await wizard(reporting([]), { telemetry: false });
      expect(steps()).toContainEqual(['complete', 'success']);
    });

    it('frames the demo guide as pending when the install is unconfirmed', async () => {
      await wizard(reporting([]));
      expect(m.showDemoGuide.mock.calls[0][0].installPending).toBe(true);
    });
  });

  describe('forwarding the agent’s markers', () => {
    it('stamps the harness itself so a forged marker cannot claim another', async () => {
      await wizard(
        harness('terminal', 'claude-code', async (ctx) => {
          ctx.onTelemetry?.({
            step: 'install',
            outcome: 'success',
            metadata: { harness: 'forged' } as never,
          });
          return { mode: 'ran', exitCode: 0 };
        }),
      );

      expect(m.telemetry.step).toHaveBeenCalledWith('install', 'success', {
        harness: 'claude-code',
      });
    });

    it('sends only the first marker for a step within one launch', async () => {
      // Decline phase 2 so only one launch happens — the dedup set is per
      // launch, and a second pass would legitimately report `plan` again.
      clack.confirm.mockResolvedValue(false);
      await wizard(
        harness('terminal', 'claude-code', async (ctx) => {
          ctx.onTelemetry?.({ step: 'plan', outcome: 'success' });
          ctx.onTelemetry?.({ step: 'plan', outcome: 'fail' });
          return { mode: 'ran', exitCode: 0 };
        }),
        { yes: false },
      );

      expect(steps().filter(([s]) => s === 'plan')).toEqual([['plan', 'success']]);
    });

    /**
     * The dedup set is per launch. A shared one would let phase 1 suppress
     * any step name phase 2 reuses, and the funnel would lose those events
     * silently.
     */
    it('does not let phase 1 suppress the same step in phase 2', async () => {
      let launched = 0;
      await wizard(
        harness('terminal', 'claude-code', async (ctx) => {
          launched += 1;
          ctx.onTelemetry?.({ step: 'explore', outcome: launched === 1 ? 'success' : 'partial' });
          return { mode: 'ran', exitCode: 0 };
        }),
      );

      expect(steps().filter(([s]) => s === 'explore')).toEqual([
        ['explore', 'success'],
        ['explore', 'partial'],
      ]);
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * Phase 2 is optional and runs after the snippet is already installed, so
 * nothing it does may reach the outer catch and misreport the run.
 */
describe('phase 2 cannot fail the run', () => {
  it('still succeeds when the user declines it', async () => {
    clack.confirm.mockResolvedValue(false);

    const code = await wizard(installing(), { yes: false });

    expect(code).toBe(0);
    expect(steps()).toContainEqual(['complete', 'success']);
    expect(m.buildEnrichPrompt).not.toHaveBeenCalled();
  });

  it('still succeeds when the integration picker is cancelled', async () => {
    m.selectIntegrations.mockRejectedValue(new CancelledError());

    const code = await wizard(installing());

    expect(code).toBe(0);
    expect(steps()).toContainEqual(['complete', 'success']);
    // The enrich run still happens, with an empty selection.
    expect(m.buildEnrichPrompt.mock.calls[0][0].selection).toEqual({
      integrations: [],
      other: [],
    });
  });

  it('still succeeds when the enrich launch throws', async () => {
    let launched = 0;
    const code = await wizard(
      installing(async () => {
        if (++launched === 2) throw new Error('agent crashed');
        return { mode: 'ran', exitCode: 0 };
      }),
    );

    expect(code).toBe(0);
    expect(steps()).toContainEqual(['complete', 'success']);
    expect(m.telemetry.note).toHaveBeenCalledWith('phase2_failed', expect.anything());
  });

  it('records a non-zero enrich exit without failing the run', async () => {
    let launched = 0;
    const code = await wizard(
      installing(async () => ({ mode: 'ran', exitCode: ++launched === 2 ? 1 : 0 })),
    );

    expect(code).toBe(0);
    expect(m.telemetry.note).toHaveBeenCalledWith('phase2_failed', { exit_code: 1 });
  });
});

// ---------------------------------------------------------------------------

describe('when the run ends badly', () => {
  it('reports a cancel as skipped and exits 130', async () => {
    m.fetchCaptureSnippet.mockRejectedValue(new CancelledError());

    const code = await wizard(harness('terminal'));

    expect(code).toBe(130);
    expect(m.telemetry.finish).toHaveBeenCalledWith('skipped', {});
    expect(clack.cancel).toHaveBeenCalled();
  });

  it('reports any other failure and exits 1', async () => {
    m.fetchCaptureSnippet.mockRejectedValue(new Error('snippet endpoint down'));

    const code = await wizard(harness('terminal'));

    expect(code).toBe(1);
    expect(m.telemetry.finish).toHaveBeenCalledWith('fail', {});
    expect(m.telemetry.note).toHaveBeenCalledWith('wizard_error', {
      error: 'snippet endpoint down',
    });
  });

  // Attribution has to survive a late failure, or the funnel loses which
  // harness the run was on.
  it('attaches the harness once one has been chosen', async () => {
    m.offerPluginSetup.mockRejectedValue(new Error('boom'));

    const code = await wizard(harness('terminal'));

    expect(code).toBe(1);
    expect(m.telemetry.finish).toHaveBeenCalledWith('fail', { harness: 'claude-code' });
  });

  it('flushes telemetry on every exit path', async () => {
    m.fetchCaptureSnippet.mockRejectedValue(new Error('down'));
    await wizard(harness('terminal'));
    expect(m.telemetry.flush).toHaveBeenCalled();

    vi.clearAllMocks();
    m.fetchCaptureSnippet.mockResolvedValue('<script>s</script>');
    await wizard(harness('terminal'));
    expect(m.telemetry.flush).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('the pre-handoff gates', () => {
  it('asks before hijacking the browser when there is no credential', async () => {
    m.authenticate.mockResolvedValue(AUTH);
    clack.confirm.mockResolvedValue(false);

    await runWizardWithoutKey();

    expect(String(clack.confirm.mock.calls[0][0].message)).toMatch(/Launch browser automatically/);
    expect(m.authenticate.mock.calls[0][1]).toBe(false);
  });

  function runWizardWithoutKey() {
    m.chooseAgent.mockResolvedValue(MANUAL_CHOICE);
    return runWizard(makeOptions({ yes: true, telemetry: false }));
  }

  it('skips the prompt review under --yes', async () => {
    await wizard(harness('terminal'));
    expect(m.offerPromptReview).not.toHaveBeenCalled();
  });

  it('shows the prompt review with the autonomy hint otherwise', async () => {
    await wizard(harness('terminal'), { yes: false });

    const choices = m.offerPromptReview.mock.calls[0][1];
    expect(choices.proceedHint).toMatch(/runs autonomously/);
    expect(choices.proceedHint).toContain('auto-accepting file edits');
  });

  it('passes the review-tools consent through to plugin setup', async () => {
    clack.confirm.mockResolvedValue(false);

    await wizard(harness('terminal'), { yes: false });

    expect(m.offerPluginSetup.mock.calls[0][4]).toBe(false);
  });

  it('aborts the run when review-tools consent is cancelled', async () => {
    clack.confirm.mockResolvedValue(clack.cancel$);

    const code = await wizard(harness('terminal'), { yes: false });

    expect(code).toBe(130);
  });
});
