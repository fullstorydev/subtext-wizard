import * as p from '@clack/prompts';
import clipboard from 'clipboardy';
import open from 'open';
import pc from 'picocolors';
import { authenticate } from './auth.js';
import { chooseAgent, detectAgents, MANUAL_CHOICE } from './agents/index.js';
import type { WizardOptions } from './config.js';
import { WIZARD_VERSION, appBaseUrl, SUBTEXT_SIGNUP_PATH, telemetryUrl } from './config.js';
import { CancelledError, selectIntegrations } from './integrations.js';
import { showLogo } from './logo.js';
import { guidePluginSetup } from './plugin.js';
import { buildInstallPrompt, type PromptTelemetry } from './prompt/build.js';
import { fetchCaptureSnippet } from './snippet.js';
import { Telemetry } from './telemetry.js';

export async function runWizard(options: WizardOptions): Promise<number> {
  const telemetry = new Telemetry(options.telemetry, options.debug);
  // Set once an agent is chosen so a post-selection cancel/fail (thrown out of
  // scope of `chosen`) can still attach the harness the rest of the funnel uses.
  let selectedHarness: string | undefined;

  await showLogo();
  p.intro(`${pc.bgCyan(pc.black(' Subtext '))} setup ${pc.dim(`v${WIZARD_VERSION}`)}`);
  p.log.message(
    'This installer sets up Subtext session capture in your app using your own coding agent.',
  );
  if (options.mock) {
    p.log.warn('Mock mode: no real network calls will be made.');
  }

  telemetry.note('wizard_started', { mock: options.mock, dir_provided: options.dir !== process.cwd() });

  try {
    // 0. TEMPORARY (until OAuth-native signup lands): offer account creation.
    //    New users have no org yet, so the OAuth login below would dead-end —
    //    send them to the Subtext signup page first, then continue into login
    //    once they confirm they're done. A pre-supplied token already implies
    //    an account, so skip the offer entirely there. Remove this whole block
    //    (and SUBTEXT_SIGNUP_PATH) when signup is part of the OAuth flow.
    if (!options.apiKey) {
      const needsAccount = await p.confirm({
        message: 'Do you need to create a new Subtext account?',
        initialValue: true,
      });
      if (p.isCancel(needsAccount)) throw new CancelledError();
      if (needsAccount) {
        const signupUrl = `${appBaseUrl(options.region)}${SUBTEXT_SIGNUP_PATH}`;
        p.log.step('Opening the Subtext account creation page in your browser.');
        p.log.info(`If it doesn't open, visit:\n${pc.cyan(signupUrl)}`);
        if (!options.mock) {
          try {
            await open(signupUrl);
          } catch {
            // URL is printed above; the user can open it manually.
          }
        }
        const created = await p.confirm({
          message: 'Did you finish creating your account? Continue to log in.',
        });
        if (p.isCancel(created) || !created) throw new CancelledError();
      }
      telemetry.note('account_creation_offered', { needed: needsAccount });
    }

    // 1. Login (browser flow) so we can fetch the org-specific snippet.
    const auth = await authenticate(options);

    // Consent gate: nothing is collected unless the user says yes here.
    // --no-telemetry skips the question (already opted out).
    let telemetryEnabled = options.telemetry;
    if (telemetryEnabled) {
      const consent = await p.confirm({
        message:
          'Is it OK if Subtext collects anonymous telemetry about this install session (step progress, outcomes, and timings — never your code or data)? It helps improve the onboarding flow.',
      });
      if (p.isCancel(consent)) throw new CancelledError();
      telemetryEnabled = consent;
      if (!consent) telemetry.disable();
    }
    // The telemetry endpoint needs an authenticated session, so delivery can
    // only start now — anything that fails before login goes unreported
    // (flagged for review). Mock runs never send real events.
    if (telemetryEnabled && !options.mock) {
      telemetry.authorize(telemetryUrl(auth.region), auth.accessToken);
    }
    telemetry.note('auth_completed', { via: options.apiKey ? 'api_key' : 'browser' });

    // 2. Org-specific capture snippet.
    const snippet = await fetchCaptureSnippet(auth, options);
    telemetry.note('snippet_fetched');

    // 3. Which integrations should the agent look for? The selection only
    //    steers the prompt — analytics_providers telemetry is left to what
    //    the agent actually detects at the link_analytics step.
    const selection = await selectIntegrations(options);
    // No outcome: an in-progress handoff. `finish` supplies fail/skipped if
    // the run ends early, and `complete` closes a successful funnel entry.
    const sendStart = (harness: string) => telemetry.step('start', undefined, { harness });

    // 4. Find the user's coding agents and pick one. We never bring our own
    //    agent — the install always runs on a harness the user already has.
    const spinner = p.spinner();
    spinner.start('Detecting coding agents on this machine…');
    const detected = await detectAgents();
    spinner.stop(
      detected.length > 0
        ? `Detected: ${detected.map((d) => d.definition.name).join(', ')}`
        : 'No coding agents detected.',
    );
    telemetry.note('agents_detected', { agents: detected.map((d) => d.definition.id) });

    const chosen = await chooseAgent(detected, options);
    const isTerminalRun = chosen !== MANUAL_CHOICE && chosen.definition.kind === 'terminal';
    const isAppRun = chosen !== MANUAL_CHOICE && chosen.definition.kind === 'app';
    selectedHarness = chosen === MANUAL_CHOICE ? 'manual' : chosen.definition.id;

    // 5. GUI apps: set up the Subtext plugin before building the prompt. Whether
    //    the plugin is actually present decides who owns telemetry, so it must be
    //    known before the prompt's telemetry section is chosen. Skipped for
    //    --print-prompt, which only previews the prompt and never hands off.
    let pluginReady = false;
    if (isAppRun && !options.printPrompt) {
      pluginReady = await guidePluginSetup(chosen, auth.region);
      telemetry.note('plugin_setup', { agent: chosen.definition.id, ready: pluginReady });
    }

    // 6. Assemble the install prompt. Terminal agents get the autonomous variant
    //    (no approval gates); app handoffs keep the interactive one.
    //    Telemetry never hands a credential to the agent's process — that would
    //    leak the OAuth token to any install subprocess (npm postinstall etc.):
    //    - terminal runs ('stdout') have the agent PRINT per-step markers the
    //      wizard parses out of the output and sends with its own token;
    //    - GUI handoffs ('mcp') log through the Subtext plugin's MCP tool, but
    //      only when that plugin is set up — otherwise the wizard owns the
    //      `start` (below) and the prompt must not tell the agent to log one
    //      too, or a still-present plugin would double-count.
    //    Either way the wizard owns the terminal `start`/`complete` bookends.
    //    --print-prompt always previews the manual-handoff variant (interactive,
    //    no agent-side telemetry): a printed prompt is pasted by hand, so no
    //    wizard is attached to parse markers and no approval gate may be skipped.
    const promptTelemetry: PromptTelemetry =
      !telemetryEnabled || options.mock || options.printPrompt
        ? 'none'
        : isTerminalRun
          ? 'stdout'
          : isAppRun && pluginReady
            ? 'mcp'
            : 'none';
    const prompt = buildInstallPrompt({
      snippet,
      selection,
      mode: isTerminalRun && !options.printPrompt ? 'headless' : 'interactive',
      telemetry: promptTelemetry,
    });

    if (options.printPrompt) {
      // No handoff happens here — we only print the prompt — so this must not
      // fire a `start` event, which would inflate the funnel with runs that
      // never began.
      console.log(prompt);
      await telemetry.flush();
      return 0;
    }

    // 7. Hand off to the agent.
    if (chosen === MANUAL_CHOICE) {
      sendStart('manual');
      let copied = true;
      try {
        await clipboard.write(prompt);
      } catch {
        copied = false;
      }
      telemetry.note('manual_handoff', { clipboard: copied });
      if (copied) {
        p.log.success('The install prompt is on your clipboard.');
        p.note(
          'Paste it into any coding agent opened at this project folder.\nThe agent will walk you through the install step by step.',
          'Next step',
        );
      } else {
        p.log.warn('Could not write to the clipboard — copy the prompt below.');
        console.log(`\n${prompt}\n`);
      }
      p.outro('Run this installer again any time with: npx @subtextdev/subtext-wizard');
      await telemetry.flush();
      return 0;
    }

    // GUI without the plugin: the prompt carries no telemetry section, so the
    // agent won't log anything — the wizard records the start itself, otherwise
    // a consented GUI handoff would produce no funnel events at all. With the
    // plugin the agent logs its own richer start (harness + model) via MCP, so
    // the wizard stays quiet to avoid double-counting.
    if (isAppRun && !pluginReady) sendStart(chosen.definition.id);

    if (isTerminalRun) {
      const confirmed = options.agent
        ? true
        : await p.confirm({
            message: `Run the install now with ${chosen.definition.name}? It will edit files in ${options.dir} (auto-accepting edits).`,
          });
      if (p.isCancel(confirmed) || !confirmed) throw new CancelledError();
      sendStart(chosen.definition.id);
    }

    // Marker lines come from an untrusted stream (the agent echoes output of
    // arbitrary repo code), so cap what it can make the wizard send: one event
    // per step, first marker wins. Legitimate cardinality is one per step.
    const sentMarkerSteps = new Set<string>();
    let agentInstallSucceeded = false;

    const result = await chosen.definition.launch({
      prompt,
      cwd: options.dir,
      binaryPath: chosen.binaryPath,
      debug: options.debug,
      onEvent: (event, properties) => telemetry.note(event, properties),
      // Per-step markers the agent printed to stdout. The wizard sends them
      // with its own token, so no credential ever reaches the agent; the
      // parser allowlists steps and metadata fields, and `harness` is written
      // last so a marker can never override attribution.
      onTelemetry: ({ step, outcome, metadata }) => {
        if (sentMarkerSteps.has(step)) return;
        sentMarkerSteps.add(step);
        if (step === 'install' && outcome === 'success') agentInstallSucceeded = true;
        telemetry.step(step, outcome, { ...metadata, harness: chosen.definition.id });
      },
    });

    telemetry.note('wizard_completed', {
      agent: chosen.definition.id,
      mode: result.mode,
      exit_code: result.exitCode ?? null,
    });
    // Terminal runs (`ran`) never hand the agent a credential, so the wizard
    // owns their `complete` event. Exit code 0 only proves the CLI ran to
    // completion — codex/gemini exit 0 even when the model refused or abandoned
    // the install — so `success` additionally requires the agent's own
    // install-step marker; exit 0 without it is recorded as `partial`. (When
    // the prompt carried no marker instructions, exit code is all we have.)
    // GUI handoffs log their own `complete` via the plugin's MCP tool.
    if (result.mode === 'ran') {
      const outcome =
        result.exitCode !== 0
          ? 'fail'
          : agentInstallSucceeded || promptTelemetry !== 'stdout'
            ? 'success'
            : 'partial';
      telemetry.step('complete', outcome, { harness: chosen.definition.id });
    }

    if (result.mode === 'handoff') {
      p.note(result.followUp?.join('\n') ?? '', 'Next steps');
      p.outro('Finish the install in your agent — it will guide you from here.');
    } else if (result.exitCode === 0) {
      p.outro(
        'Subtext install finished. Review the changes (and subtext-setup-report.md), then deploy to start capturing sessions.',
      );
    } else {
      p.outro(
        pc.yellow(
          `The agent exited with code ${result.exitCode}. Review its output above; you can re-run this installer to try again.`,
        ),
      );
    }

    await telemetry.flush();
    return result.mode === 'ran' ? (result.exitCode ?? 1) : 0;
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
