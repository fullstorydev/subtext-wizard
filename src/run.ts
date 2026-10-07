import * as p from '@clack/prompts';
import clipboard from 'clipboardy';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import {
  buildEnrichPrompt,
  buildSnippetPrompt,
  type PromptMode,
  type PromptTelemetry,
} from './prompt/build.js';
import { offerPromptReview } from './promptReview.js';
import {
  EXTRAS_REPORT,
  SETUP_REPORT,
  detectAuthLibraries,
  readExtrasResults,
  showExtrasPlan,
  showExtrasResults,
  type ExtrasResults,
  type ExtrasScope,
} from './extras.js';
import { fetchCaptureSnippet } from './snippet.js';
import { runStaticInstall } from './staticInstall/index.js';
import { Telemetry } from './telemetry.js';

export async function runWizard(options: WizardOptions): Promise<number> {
  const telemetry = new Telemetry(options.telemetry, options.debug);
  // Set once an agent is chosen so a post-selection cancel/fail (thrown out of
  // scope of `chosen`) can still attach the harness the rest of the funnel uses.
  let selectedHarness: string | undefined;

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
    const snippetInstalled = staticInstall.status !== 'fallback';

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

    // 4. GUI apps: set up the Subtext plugin before building the prompt. Whether
    //    the plugin is actually present decides who owns telemetry, so it must be
    //    known before the prompt's telemetry section is chosen.
    let pluginReady = false;
    if (isAppRun) {
      pluginReady = await guidePluginSetup(chosen, auth.region);
      telemetry.note('plugin_setup', { agent: chosen.definition.id, ready: pluginReady });
    }

    // --print-prompt is a testing aid: it prints each install prompt to stdout
    // right before it's used, then lets the normal flow run. It deliberately no
    // longer overrides mode/telemetry — the printed prompt is exactly the one
    // that runs, so a terminal agent still gets the headless variant it needs.
    const printPromptForTesting = (label: string, prompt: string) => {
      if (options.printPrompt) console.log(`\n===== ${label} =====\n\n${prompt}\n`);
    };

    // 5. Assemble the phase-1 (snippet) install prompt. Terminal agents get the
    //    autonomous variant (no approval gates); app handoffs keep the
    //    interactive one. Telemetry never hands a credential to the agent's
    //    process — that would leak the OAuth token to any install subprocess
    //    (npm postinstall etc.):
    //    - terminal runs ('stdout') have the agent PRINT per-step markers the
    //      wizard parses out of the output and sends with its own token;
    //    - GUI handoffs ('mcp') log through the Subtext plugin's MCP tool, but
    //      only when that plugin is set up — otherwise the wizard owns the
    //      `start` (below) and the prompt must not tell the agent to log one
    //      too, or a still-present plugin would double-count.
    //    Either way the wizard owns the terminal `start`/`complete` bookends.
    const promptTelemetry: PromptTelemetry =
      !telemetryEnabled || options.mock
        ? 'none'
        : isTerminalRun
          ? 'stdout'
          : isAppRun && pluginReady
            ? 'mcp'
            : 'none';
    const promptMode: PromptMode = isTerminalRun ? 'headless' : 'interactive';

    const snippetPrompt = buildSnippetPrompt({ snippet, mode: promptMode, telemetry: promptTelemetry });
    if (!snippetInstalled) printPromptForTesting('STEP 1: capture snippet install prompt', snippetPrompt);

    // For terminal agents the install runs autonomously; name what it
    // auto-approves so the single pre-handoff gate below carries that consent
    // itself — no separate "are you sure" confirm. MANUAL_CHOICE has no
    // definition to read from.
    const autonomy =
      chosen !== MANUAL_CHOICE
        ? (chosen.definition.autonomy ?? 'auto-accepting file edits')
        : 'auto-accepting file edits';

    if (!snippetInstalled) p.log.step(pc.bold('Install the capture snippet'));

    // 6. Pre-handoff transparency AND consent in one gate: the user reads the
    //    exact prompt the agent will run, and proceeding is the authorization.
    //    For terminal runs the proceed option names the autonomous run, so no
    //    second confirm follows. --yes (CI) skips the gate, and there's nothing
    //    to hand off when the wizard already installed the snippet.
    if (!options.yes && !snippetInstalled) {
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

    // The single funnel `start`. Sent per branch below (matching who owns
    // telemetry), exactly once — the two hand-offs of a terminal run are one
    // funnel entry with one `start` and one `complete`.
    // A static install did the snippet-phase steps the agent would otherwise
    // report, so the wizard reports them right after the start.
    const sendStart = (harness: string) => {
      telemetry.step('start', undefined, { harness });
      if (staticInstall.status === 'already-installed') {
        telemetry.step('precheck', 'success', { already_installed: true, harness });
      } else if (staticInstall.status === 'installed') {
        telemetry.step('precheck', 'success', { already_installed: false, harness });
        telemetry.step('explore', 'success', { framework: staticInstall.framework, csp_present: false, harness });
        telemetry.step('plan', 'success', { approved: true, harness });
        telemetry.step('install', 'success', { harness });
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
      const scope = { selection, authLibraries: detectAuthLibraries(options.dir) };
      showExtrasPlan(scope);
      return scope;
    };

    // ----- Manual handoff: copy the phase-1 prompt, then offer phase 2 as a
    // copyable follow-up (we never drive a manual agent, so no second run). ---
    if (chosen === MANUAL_CHOICE) {
      sendStart('manual');
      let copied = false;
      // Only the agent-driven install has a step-1 prompt to hand over.
      if (!snippetInstalled) {
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
            'Paste it into any coding agent opened at this project folder.\nThe agent will walk you through the snippet install step by step.',
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
        installPending: !snippetInstalled,
        clipboardHoldsInstallPrompt: copied,
        yes: options.yes,
        onEvent,
      });
      if (await confirmExtras()) {
        const enrichPrompt = buildEnrichPrompt({
          ...(await scopeExtras()),
          mode: 'interactive',
          telemetry: 'none',
        });
        printPromptForTesting('STEP 2: enrichment prompt', enrichPrompt);
        await offerFollowUpPrompt({
          prompt: enrichPrompt,
          agentName: 'your coding agent',
          clipboardBusy: copied,
          yes: options.yes,
          onEvent,
        });
      }
      p.outro(snippetInstalled ? DEPLOY_OUTRO : 'Run this installer again any time with: npx @subtextdev/subtext-wizard');
      await telemetry.flush();
      return 0;
    }

    // ----- GUI app handoff: open the app once, then offer phase 2 as a copyable
    // follow-up. GUI without the plugin: the prompt carries no telemetry
    // section, so the agent won't log anything — the wizard records the start
    // itself, otherwise a consented GUI handoff would produce no funnel events
    // at all. With the plugin the agent logs its own richer start (harness +
    // model) via MCP, so the wizard stays quiet to avoid double-counting. ------
    if (isAppRun) {
      const openTarget: OpenAgentTarget = {
        kind: 'app',
        name: chosen.definition.name,
        binaryPath: chosen.binaryPath,
        macAppName: chosen.macAppName,
        opensFolder: chosen.opensFolder,
        dir: options.dir,
      };
      // With the snippet already in, the agent never runs a phase-1 prompt to
      // log its own start, so the wizard sends it even when the plugin is ready.
      if (!pluginReady || snippetInstalled) sendStart(chosen.definition.id);
      // --print-prompt is a dry run: the prompt was already printed above, so
      // don't open the app / hand off — synthesize a clean handoff result.
      // Same when the snippet is already installed: there's nothing to hand off.
      const result: LaunchResult = options.printPrompt || snippetInstalled
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
      if (!snippetInstalled && result.followUp?.length) p.note(result.followUp.join('\n'), 'Next steps');
      await showDemoGuide({
        agentName: chosen.definition.name,
        installPending: !snippetInstalled,
        clipboardHoldsInstallPrompt: result.clipboardHoldsPrompt,
        yes: options.yes,
        // Suppressed under --print-prompt so the demo's "Open agent?" offer
        // can't launch the app during a dry run.
        openTarget: options.printPrompt ? undefined : openTarget,
        onEvent,
      });
      if (await confirmExtras()) {
        const enrichPrompt = buildEnrichPrompt({
          ...(await scopeExtras()),
          mode: 'interactive',
          telemetry: 'none',
        });
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
        snippetInstalled
          ? DEPLOY_OUTRO
          : 'Finish the install in your agent — it will guide you from here.',
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

    // Drive one launch, parsing the agent's per-step stdout markers. Marker
    // lines come from an untrusted stream (the agent echoes output of arbitrary
    // repo code), so cap what it can make the wizard send: one event per step,
    // first marker wins. A FRESH dedup set per launch is essential — otherwise
    // the phase-1 set would suppress the phase-2 markers for any step name they
    // share, and the funnel would lose them.
    const driveLaunch = async (
      launchPrompt: string,
      label: string,
    ): Promise<{ result: LaunchResult; installSucceeded: boolean }> => {
      if (options.printPrompt) {
        // --print-prompt is a dry run: the prompt was already printed above, so
        // skip actually spawning the agent and report a clean no-op so the rest
        // of the flow (demo guide, phase-2 prompt) still runs.
        p.log.info(pc.dim('--print-prompt — skipping the agent run.'));
        return { result: { mode: 'ran', exitCode: 0 }, installSucceeded: true };
      }
      const sentMarkerSteps = new Set<string>();
      let installSucceeded = false;
      const result = await chosen.definition.launch({
        prompt: launchPrompt,
        cwd: options.dir,
        binaryPath: chosen.binaryPath,
        debug: options.debug,
        label,
        onEvent,
        // Per-step markers the agent printed to stdout. The wizard sends them
        // with its own token, so no credential ever reaches the agent; the
        // parser allowlists steps and metadata fields, and `harness` is written
        // last so a marker can never override attribution.
        onTelemetry: ({ step, outcome, metadata }) => {
          if (sentMarkerSteps.has(step)) return;
          sentMarkerSteps.add(step);
          if (step === 'install' && outcome === 'success') installSucceeded = true;
          telemetry.step(step, outcome, { ...metadata, harness: chosen.definition.id });
        },
      });
      return { result, installSucceeded };
    };

    // Phase 1 — install the snippet, unless the wizard already did.
    const { result, installSucceeded } = snippetInstalled
      ? { result: { mode: 'ran', exitCode: 0 } as LaunchResult, installSucceeded: true }
      : await driveLaunch(snippetPrompt, 'Installing the snippet');
    // Claude Code hands its closing message back instead of streaming it.
    if (!snippetInstalled && result.finalMessage) {
      p.log.message(pc.dim(result.finalMessage));
    }
    telemetry.note('wizard_completed', {
      agent: chosen.definition.id,
      mode: result.mode,
      exit_code: result.exitCode ?? null,
    });

    // Exit code 0 only proves the CLI ran to completion — codex/gemini exit 0
    // even when the model refused or abandoned the install — so `success`
    // additionally requires the agent's own install-step marker; exit 0 without
    // it is recorded as `partial`. (When the prompt carried no marker
    // instructions, exit code is all we have.)
    const installConfirmed = snippetInstalled || installSucceeded || promptTelemetry !== 'stdout';

    if (result.exitCode !== 0) {
      // Phase 1 failed — the snippet isn't in, so there's nothing to review and
      // no point offering the enrichment run. Close the funnel as failed.
      telemetry.step('complete', 'fail', { harness: chosen.definition.id });
      p.outro(
        pc.yellow(
          `The agent exited with code ${result.exitCode}. Review its output above; you can re-run this installer to try again.`,
        ),
      );
      await telemetry.flush();
      return result.exitCode ?? 1;
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
      // Exit 0 without the agent's install marker means the install may have
      // been refused or abandoned — frame the guide as post-install work.
      installPending: !installConfirmed,
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
    let extras: ExtrasResults | undefined;
    let extrasRan = false;
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
          const enrichPrompt = buildEnrichPrompt({ ...scope, mode: 'headless', telemetry: promptTelemetry });
          printPromptForTesting('STEP 2: enrichment prompt', enrichPrompt);
          const startedAt = Date.now();
          const { result: enrichResult } = await driveLaunch(enrichPrompt, 'Adding the extras');
          extrasRan = true;
          telemetry.note('phase2_completed', { exit_code: enrichResult.exitCode ?? null });
          if (enrichResult.exitCode !== 0) {
            telemetry.note('phase2_failed', { exit_code: enrichResult.exitCode ?? null });
          }
          // Our own summary from the agent's result file; its raw message is
          // only the fallback when the file never got written.
          extras = readExtrasResults(options.dir, startedAt);
          if (extras) showExtrasResults(extras);
          else if (enrichResult.finalMessage) p.log.message(pc.dim(enrichResult.finalMessage));
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

    // The single `complete` for the whole (two-phase) terminal run.
    telemetry.step('complete', installConfirmed ? 'success' : 'partial', {
      harness: chosen.definition.id,
    });
    p.outro(terminalOutro(options.dir, !snippetInstalled, extrasRan, extras));
    await telemetry.flush();
    return 0;
  } catch (error) {
    // Attach the harness if an agent was already chosen, so post-selection
    // cancel/fail events carry the same agent id as the rest of the funnel.
    const harnessMeta = selectedHarness ? { harness: selectedHarness } : {};
    if (error instanceof CancelledError) {
      telemetry.finish('skipped', harnessMeta);
      p.cancel('Setup cancelled — nothing was changed.');
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
function terminalOutro(
  dir: string,
  agentInstalledSnippet: boolean,
  extrasRan: boolean,
  extras: ExtrasResults | undefined,
): string {
  // Only point at reports this run could have written.
  const candidates = [...(extrasRan ? [EXTRAS_REPORT] : []), ...(agentInstalledSnippet ? [SETUP_REPORT] : [])];
  const report = candidates.find((f) => fs.existsSync(path.join(dir, f)));
  const details = report ? `\nDetails in ${report}` : '';
  if (!extrasRan) return `${DEPLOY_OUTRO}${details}`;
  if (extras && extras.filesChanged.length === 0) {
    return `No other code changes were needed. Deploy to start capturing real user sessions.${details}`;
  }
  return `Review the changes, then deploy to start capturing real user sessions.${details}`;
}
