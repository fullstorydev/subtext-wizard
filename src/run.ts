import * as p from '@clack/prompts';
import clipboard from 'clipboardy';
import os from 'node:os';
import pc from 'picocolors';
import { authenticate } from './auth.js';
import { chooseAgent, detectAgents, MANUAL_CHOICE } from './agents/index.js';
import type { LaunchResult } from './agents/types.js';
import type { WizardOptions } from './config.js';
import { WIZARD_VERSION, telemetryUrl } from './config.js';
import { showDemoGuide } from './demo.js';
import { offerFollowUpPrompt } from './followUp.js';
import type { OpenAgentTarget } from './openAgent.js';
import {
  CancelledError,
  selectIntegrations,
  type IntegrationSelection,
} from './integrations.js';
import { showLogo } from './logo.js';
import { guidePluginSetup } from './plugin.js';
import { offerPluginSetup, subtextPluginInstalled } from './pluginSetup.js';
import { EXTRAS_STEPS, SNIPPET_STEPS, buildJoinedPrompt, buildStepPrompt, type InstallStep } from './prompt/build.js';
import { offerPromptReview } from './promptReview.js';
import { showExtrasPlan, showExtrasResults, type ExtrasScope } from './extras.js';
import { fetchCaptureSnippet } from './snippet.js';
import { runStaticInstall } from './staticInstall/index.js';
import { filesChanged, reportSteps, runSteps, type StepResults } from './steps.js';
import { Telemetry } from './telemetry.js';

export async function runWizard(options: WizardOptions): Promise<number> {
  const telemetry = new Telemetry(options.telemetry, options.debug);
  // Set once an agent is chosen so a post-selection cancel/fail (thrown out of
  // scope of `chosen`) can still attach the harness the rest of the funnel uses.
  let selectedHarness: string | undefined;
  // Once the wizard has written the snippet, a cancel can't claim nothing changed.
  let snippetWritten = false;

  await showLogo();
  p.intro(`${pc.bgCyan(pc.black(' Subtext '))} setup ${pc.dim(`v${WIZARD_VERSION}`)}`);
  p.log.message(pc.dim(`Setting up session capture in ${tildify(options.dir)}`));
  if (options.mock) {
    p.log.warn('Mock mode: no real network calls will be made.');
    if (!options.apiKey) {
      const ignored = ['SUBTEXT_API_KEY', 'SUBTEXT_API_KEY_OAUTH'].filter((n) => process.env[n]);
      if (ignored.length > 0) {
        p.log.warn(`Ignoring ${ignored.join(' and ')} in mock mode — using canned auth.`);
      }
    }
  }

  telemetry.note('wizard_started', { mock: options.mock, dir_provided: options.dir !== process.cwd() });

  const onEvent = (event: string, properties?: Record<string, unknown>) =>
    telemetry.note(event, properties);

  try {
    // 1. Login (browser flow) so we can fetch the org-specific snippet.
    //    Ask once, up front, before hijacking the browser — a tab popping open
    //    unprompted is jarring. The answer governs every automatic page-open in
    //    the run (login here, prompt review later); on "no" we just print the
    //    links instead. Skipped with --api-key, where there's no browser login.
    let openInBrowser = true;
    if (!options.apiKey) {
      const consent = await p.confirm({
        message: 'Launch browser automatically to log in?',
      });
      if (p.isCancel(consent)) throw new CancelledError();
      openInBrowser = consent;
    }
    const auth = await authenticate(options, openInBrowser);
    telemetry.note('auth_completed', { via: options.apiKey ? 'api_key' : 'browser' });

    // 2. Org-specific capture snippet.
    const snippet = await fetchCaptureSnippet(auth, options);
    telemetry.note('snippet_fetched');

    // Telemetry is ON by default — announce it (no prompt) and point at the
    // opt-out. The notice names agent token usage explicitly, since the funnel
    // records it (tokens/total_tokens) alongside step progress. --no-telemetry
    // and the DO_NOT_TRACK / DISABLE_TELEMETRY env vars all resolve to
    // options.telemetry === false before we get here — the env vars silently,
    // with no notice shown.
    // --print-prompt is a dry run that never installs, so it must not emit
    // funnel events (start/complete) — that would inflate onboarding metrics
    // with runs that never began. Leaving telemetry unauthorized drops every
    // event (there's nowhere to send them), and the notice would be misleading.
    const telemetryEnabled = options.telemetry;
    if (telemetryEnabled && !options.printPrompt) {
      p.log.info(
        pc.dim(`Anonymous install telemetry is on: step progress and timings, never your code or data. Opt out with --no-telemetry.`),
      );
    }
    // The telemetry endpoint needs an authenticated session, so delivery can
    // only start now — no step events are sent before this point, so nothing
    // is lost by asking after the snippet fetch. Mock and dry (--print-prompt)
    // runs never send real events.
    if (telemetryEnabled && !options.mock && !options.printPrompt) {
      telemetry.authorize(telemetryUrl(auth.region), auth.accessToken, auth.authScheme);
    }

    // Integration selection has moved into the enrichment step (phase 2): the
    // fast path to a first captured session only installs the snippet, so we
    // don't need to know the analytics stack until we link the session URL in.

    // Common frameworks get the snippet written by the wizard itself, which is
    // faster and deterministic. Anything it can't place with certainty (or a
    // declined/failed edit) falls through to the agent-driven install below.
    const staticInstall = await runStaticInstall(snippet, options, onEvent);
    // After a static install the agent still checks for a CSP. An existing
    // snippet is the user's own setup, so it's left as is.
    const snippetInstalled = staticInstall.status !== 'fallback';
    snippetWritten = staticInstall.status === 'installed';
    let snippetSteps: InstallStep[] = [];
    if (staticInstall.status === 'fallback') snippetSteps = SNIPPET_STEPS;
    else if (staticInstall.status === 'installed') snippetSteps = ['csp'];
    // Whether there's agent work before the first session: the full install,
    // or just the CSP check after the wizard wrote the snippet.
    const agentWork = snippetSteps.length > 0;
    const stepOneTitle = snippetInstalled ? 'Check the Content-Security-Policy' : 'Install the capture snippet';

    // 3. Find the user's coding agents and pick one. We never bring our own
    //    agent — the install always runs on a harness the user already has.
    // No "Detected: …" line; the picker right after lists them.
    const detected = await detectAgents();
    telemetry.note('agents_detected', { agents: detected.map((d) => d.definition.id) });

    const chosen = await chooseAgent(
      detected,
      options,
      snippetInstalled
        ? 'Which coding agent should review your sessions and run step 2?'
        : undefined,
    );
    const isTerminalRun = chosen !== MANUAL_CHOICE && chosen.definition.kind === 'terminal';
    const isAppRun = chosen !== MANUAL_CHOICE && chosen.definition.kind === 'app';
    selectedHarness = chosen === MANUAL_CHOICE ? 'manual' : chosen.definition.id;

    // 4. GUI apps: set up the Subtext plugin before handing off, so the agent
    //    can review sessions as soon as the install is in.
    if (isAppRun) {
      const pluginReady = await guidePluginSetup(chosen, auth.region);
      telemetry.note('plugin_setup', { agent: chosen.definition.id, ready: pluginReady });
    }

    // --print-prompt is a testing aid: it prints each install prompt to stdout
    // right before it's used, then lets the normal flow run. It deliberately no
    // longer overrides mode/telemetry — the printed prompt is exactly the one
    // that runs, so a terminal agent still gets the headless variant it needs.
    const printPromptForTesting = (label: string, prompt: string) => {
      if (options.printPrompt) console.log(`\n===== ${label} =====\n\n${prompt}\n`);
    };

    // 5. The snippet steps. Terminal agents get one fresh run per step; the
    //    user-driven handoffs get the same steps joined into one prompt.
    const snippetPrompt = isTerminalRun
      ? snippetSteps.map((step) => buildStepPrompt(step, { snippet })).join('\n\n---\n\n')
      : buildJoinedPrompt(snippetSteps, { snippet }, 'interactive');
    if (agentWork) printPromptForTesting(`STEP 1: ${stepOneTitle}`, snippetPrompt);

    // For terminal agents the install runs autonomously; name what it
    // auto-approves so the single pre-handoff gate below carries that consent
    // itself — no separate "are you sure" confirm. MANUAL_CHOICE has no
    // definition to read from.
    const autonomy =
      chosen !== MANUAL_CHOICE
        ? (chosen.definition.autonomy ?? 'auto-accepting file edits')
        : 'auto-accepting file edits';

    if (agentWork) p.log.step(pc.bold(stepOneTitle));

    // 6. Pre-handoff transparency AND consent in one gate: the user reads the
    //    exact prompt the agent will run, and proceeding is the authorization.
    //    For terminal runs the proceed option names the autonomous run, so no
    //    second confirm follows. --yes (CI) skips the gate, and there's nothing
    //    to hand off when the wizard already installed the snippet.
    if (!options.yes && agentWork) {
      const proceedLabel =
        chosen === MANUAL_CHOICE
          ? 'Continue'
          : isTerminalRun
            ? `Run the install now with ${chosen.definition.name}`
            : `Open ${chosen.definition.name} with the install prompt`;
      const proceedHint =
        chosen !== MANUAL_CHOICE && isTerminalRun
          ? `runs autonomously in ${options.dir}, ${autonomy}`
          : undefined;
      const { reviewed } = await offerPromptReview(snippetPrompt, {
        proceedLabel,
        proceedHint,
        openInBrowser,
      });
      if (reviewed) telemetry.note('prompt_reviewed');
    }

    // Session-review tools (the Subtext plugin / MCP server) let the agent
    // replay captured sessions. For terminal runs the setup happens after the
    // install (so it's wired into the harness that just ran) — but we ask for
    // consent HERE, bundled with the pre-handoff step, so the post-install
    // first-ASR guide isn't interrupted by another prompt. App handoffs wire
    // this before the handoff (guidePluginSetup); the manual path only prints
    // instructions; --yes proceeds without asking.
    let reviewToolsConsent: boolean | undefined;
    if (isTerminalRun && !options.yes && (await subtextPluginInstalled(chosen, auth.region, options))) {
      // offerPluginSetup reports it as already installed later; nothing to ask.
      reviewToolsConsent = true;
    } else if (isTerminalRun && !options.yes) {
      const answer = await p.confirm({
        message: `Install the Subtext plugin in ${chosen.definition.name}? ${pc.dim('(lets it replay your sessions)')}`,
      });
      // Ctrl+C aborts the whole run: nothing has been installed yet, so cancel
      // must mean "stop" — consistent with every other pre-handoff prompt.
      // Only an explicit "No" declines the plugin and lets the install proceed.
      if (p.isCancel(answer)) throw new CancelledError();
      reviewToolsConsent = answer;
    }

    // The single funnel `start`, plus the install step when the wizard already
    // wrote the snippet itself. The wizard owns all telemetry; agents never
    // report anything.
    const sendStart = (harness: string) => {
      telemetry.step('start', undefined, { harness });
      if (staticInstall.status === 'already-installed') {
        telemetry.step('precheck', 'success', { already_installed: true, harness });
      }
    };

    // The optional extras gate (identify users, link analytics, mask PII).
    // Returns false on decline or Ctrl+C and never throws: a "no" here must
    // not fail a run whose snippet is in. It also holds the terminal while the
    // user is off trying the demo.
    const confirmExtras = async (): Promise<boolean> => {
      if (options.yes) return true;
      const answer = await p.confirm({
        message: `Continue to optional extras? ${pc.dim('(identify users, link analytics, mask PII)')}`,
        initialValue: true,
      });
      return !p.isCancel(answer) && answer;
    };

    // Check package.json for what the extras can attach to, so the agent pass
    // is scoped (or visibly empty) before anything runs. A Ctrl+C on the
    // optional picker maps to an empty selection rather than aborting.
    const scopeExtras = async (): Promise<ExtrasScope> => {
      let selection: IntegrationSelection = { integrations: [], other: [] };
      try {
        selection = await selectIntegrations(options);
      } catch (error) {
        if (!(error instanceof CancelledError)) throw error;
      }
      const scope = { selection };
      showExtrasPlan(scope);
      return scope;
    };

    // ----- Manual handoff: copy the phase-1 prompt, then offer phase 2 as a
    // copyable follow-up (we never drive a manual agent, so no second run). ---
    if (chosen === MANUAL_CHOICE) {
      sendStart('manual');
      let copied = false;
      if (agentWork) {
        try {
          await clipboard.write(snippetPrompt);
          copied = true;
        } catch {
          copied = false;
        }
        telemetry.note('manual_handoff', { clipboard: copied });
        if (copied) {
          p.log.success('The install prompt is on your clipboard.');
          p.note(
            `Paste it into any coding agent opened at this project folder.\nThe agent will walk you through ${snippetInstalled ? 'the CSP check' : 'the snippet install'} step by step.`,
            'Next step',
          );
        } else {
          p.log.warn('Could not write to the clipboard — copy the prompt below.');
          console.log(`\n${snippetPrompt}\n`);
        }
      }
      // Plugin setup — we don't know the harness, so show every path.
      await offerPluginSetup(MANUAL_CHOICE, auth.region, options, onEvent);
      await showDemoGuide({
        agentName: 'your coding agent',
        installPending: agentWork,
        clipboardHoldsInstallPrompt: copied,
        yes: options.yes,
        onEvent,
      });
      if (await confirmExtras()) {
        const enrichPrompt = buildJoinedPrompt(EXTRAS_STEPS, await scopeExtras(), 'interactive');
        printPromptForTesting('STEP 2: enrichment prompt', enrichPrompt);
        await offerFollowUpPrompt({
          prompt: enrichPrompt,
          agentName: 'your coding agent',
          clipboardBusy: copied,
          yes: options.yes,
          onEvent,
        });
      }
      p.outro(agentWork ? 'Run this installer again any time with: npx @subtextdev/subtext-wizard' : DEPLOY_OUTRO);
      await telemetry.flush();
      return 0;
    }

    // ----- GUI app handoff: open the app once, then offer phase 2 as a copyable
    // follow-up. The wizard can't see what happens in the app, so it reports
    // only the start. -------------------------------------------------------
    if (isAppRun) {
      const openTarget: OpenAgentTarget = {
        kind: 'app',
        name: chosen.definition.name,
        binaryPath: chosen.binaryPath,
        macAppName: chosen.macAppName,
        opensFolder: chosen.opensFolder,
        dir: options.dir,
      };
      sendStart(chosen.definition.id);
      // --print-prompt is a dry run: the prompt was already printed above, so
      // don't open the app / hand off — synthesize a clean handoff result.
      // Same when the snippet is already installed: there's nothing to hand off.
      const result: LaunchResult = options.printPrompt || !agentWork
        ? { mode: 'handoff', exitCode: 0, clipboardHoldsPrompt: false }
        : await chosen.definition.launch({
            prompt: snippetPrompt,
            cwd: options.dir,
            binaryPath: chosen.binaryPath,
            debug: options.debug,
            onEvent,
          });
      telemetry.note('wizard_completed', {
        agent: chosen.definition.id,
        mode: result.mode,
        exit_code: result.exitCode ?? null,
      });
      if (agentWork && result.followUp?.length) p.note(result.followUp.join('\n'), 'Next steps');
      await showDemoGuide({
        agentName: chosen.definition.name,
        installPending: agentWork,
        clipboardHoldsInstallPrompt: result.clipboardHoldsPrompt,
        yes: options.yes,
        // Suppressed under --print-prompt so the demo's "Open agent?" offer
        // can't launch the app during a dry run.
        openTarget: options.printPrompt ? undefined : openTarget,
        onEvent,
      });
      if (await confirmExtras()) {
        const enrichPrompt = buildJoinedPrompt(EXTRAS_STEPS, await scopeExtras(), 'interactive');
        printPromptForTesting('STEP 2: enrichment prompt', enrichPrompt);
        await offerFollowUpPrompt({
          prompt: enrichPrompt,
          agentName: chosen.definition.name,
          clipboardBusy: result.clipboardHoldsPrompt,
          yes: options.yes,
          openTarget: options.printPrompt ? undefined : openTarget,
          onEvent,
        });
      }
      p.outro(
        agentWork
          ? 'Finish the install in your agent — it will guide you from here.'
          : DEPLOY_OUTRO,
      );
      await telemetry.flush();
      return 0;
    }

    // ----- Terminal run: drive the snippet install, then (after the first-ASR
    // guide) drive a second run for the enrichment step. --------------------
    // Consent for this autonomous run was captured at the prompt-review gate
    // above — proceeding there names the autonomy, so there's no second
    // confirm. --yes (CI) skipped the gate and proceeds straight here.
    sendStart(chosen.definition.id);

    const harness = chosen.definition.id;
    const runner = {
      agent: chosen,
      dir: options.dir,
      debug: options.debug,
      telemetry,
      dryRun: options.printPrompt,
    };

    // Phase 1: install the snippet, unless the wizard already did.
    const snippetResults: StepResults = agentWork ? await runSteps(runner, snippetSteps, { snippet }) : {};
    if (staticInstall.status === 'installed') {
      snippetResults.capture = { status: 'done', detail: '', filesChanged: [] };
    }
    reportSteps(telemetry, snippetResults, {
      harness,
      ...(staticInstall.status === 'installed' ? { framework: staticInstall.framework } : {}),
    });
    // Only `done` means the snippet is in; a skipped or unreported capture isn't.
    const snippetFailed = !snippetInstalled && !options.printPrompt && snippetResults.capture?.status !== 'done';
    telemetry.note('wizard_completed', { agent: harness, snippet: snippetResults.capture?.status ?? 'static' });

    if (snippetFailed) {
      // The snippet isn't in, so there's nothing to review and no point
      // offering the extras. Close the funnel as failed.
      telemetry.step('complete', 'fail', { harness });
      p.outro(
        pc.yellow(
          `The snippet install didn't finish${snippetResults.capture?.detail ? ` (${snippetResults.capture.detail})` : ''}. Review the output above; you can re-run this installer to try again.`,
        ),
      );
      await telemetry.flush();
      return 1;
    }

    // Wire Subtext into the harness that ran the install (packaged plugin where
    // one exists, raw MCP entry otherwise) so the agent can review sessions,
    // then show the first-ASR guide. Consent was captured pre-handoff
    // (reviewToolsConsent) so this runs without a fresh prompt. Skipped under
    // --print-prompt: the packaged-plugin path spawns the agent CLI, and a dry
    // run must not launch the agent.
    if (!options.printPrompt) {
      await offerPluginSetup(chosen, auth.region, options, onEvent, reviewToolsConsent);
    }
    await showDemoGuide({
      agentName: chosen.definition.name,
      installPending: false,
      yes: options.yes,
      // Suppressed under --print-prompt so the demo's "Open agent?" offer can't
      // spawn the agent during a dry run.
      openTarget: options.printPrompt
        ? undefined
        : {
            kind: 'terminal',
            name: chosen.definition.name,
            binaryPath: chosen.binaryPath,
            dir: options.dir,
          },
      onEvent,
    });

    // Phase 2 — the enrichment run, offered after the user has seen capture
    // work. A decline or a Ctrl+C here is NOT a failure: the snippet (the thing
    // that matters for capture) is already in, so we must never let this reach
    // the outer catch and misreport the run as cancelled/failed.
    let extras: StepResults | undefined;
    try {
      if (await confirmExtras()) {
        const scope = await scopeExtras();
        // The consent for this autonomous pass sits right before it starts,
        // after the user has seen exactly what it will do.
        const go = options.yes
          ? true
          : await p.confirm({
              message: `${chosen.definition.name} will ${chosen.definition.consent ?? 'edit files'}. Continue?`,
            });
        if (go === true) {
          printPromptForTesting(
            'STEP 2: enrichment prompts',
            EXTRAS_STEPS.map((step) => buildStepPrompt(step, scope)).join('\n\n---\n\n'),
          );
          extras = await runSteps(runner, EXTRAS_STEPS, scope);
          reportSteps(telemetry, extras, {
            harness,
            analyticsProviders: scope.selection.integrations.map((i) => i.id),
          });
          if (options.printPrompt) extras = undefined;
          else showExtrasResults(extras);
        }
      }
    } catch (error) {
      // Enrichment is optional and the snippet install stands, so anything
      // thrown here is noted, never surfaced as a failed run.
      if (!(error instanceof CancelledError)) {
        telemetry.note('phase2_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    telemetry.step('complete', 'success', { harness });
    p.outro(terminalOutro(extras));
    await telemetry.flush();
    return 0;
  } catch (error) {
    // Attach the harness if an agent was already chosen, so post-selection
    // cancel/fail events carry the same agent id as the rest of the funnel.
    const harnessMeta = selectedHarness ? { harness: selectedHarness } : {};
    if (error instanceof CancelledError) {
      telemetry.finish('skipped', harnessMeta);
      p.cancel(snippetWritten ? 'Setup cancelled. The snippet the wizard added is still in place.' : 'Setup cancelled — nothing was changed.');
      await telemetry.flush();
      return 130;
    }
    // The endpoint has no field for the error message itself (flagged for
    // review) — only the fail outcome goes up.
    telemetry.finish('fail', harnessMeta);
    telemetry.note('wizard_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro(pc.red('Setup failed.'));
    await telemetry.flush();
    return 1;
  }
}

function tildify(dir: string): string {
  const home = os.homedir();
  return dir === home || dir.startsWith(home + '/') ? `~${dir.slice(home.length)}` : dir;
}

const DEPLOY_OUTRO = 'Subtext capture is installed. Deploy to start capturing real user sessions.';

/** The closing line, matched to what actually happened in the run. */
function terminalOutro(extras: StepResults | undefined): string {
  if (!extras) return DEPLOY_OUTRO;
  if (filesChanged(extras).length === 0) {
    return 'No other code changes were needed. Deploy to start capturing real user sessions.';
  }
  return 'Review the changes, then deploy to start capturing real user sessions.';
}
