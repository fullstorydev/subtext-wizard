import * as p from '@clack/prompts';
import clipboard from 'clipboardy';
import pc from 'picocolors';
import { authenticate } from './auth.js';
import { chooseAgent, detectAgents, MANUAL_CHOICE } from './agents/index.js';
import type { WizardOptions } from './config.js';
import { WIZARD_VERSION, telemetryUrl } from './config.js';
import { CancelledError, selectIntegrations } from './integrations.js';
import { showLogo } from './logo.js';
import { guidePluginSetup } from './plugin.js';
import { buildInstallPrompt } from './prompt/build.js';
import { fetchCaptureSnippet } from './snippet.js';
import { Telemetry } from './telemetry.js';

export async function runWizard(options: WizardOptions): Promise<number> {
  const telemetry = new Telemetry(options.telemetry, options.debug);

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

    // 5. Assemble the install prompt. Terminal agents get the autonomous
    //    variant (no approval gates); app handoffs keep the interactive one.
    //    Agent-side telemetry: terminal runs curl the endpoint with a token
    //    we pass via env; GUI runs log through the Subtext plugin's MCP tool
    //    (set up below); manual handoffs get none — we won't paste the
    //    user's access token into a clipboard prompt (flagged for review).
    const prompt = buildInstallPrompt({
      snippet,
      selection,
      mode: isTerminalRun ? 'headless' : 'interactive',
      telemetry:
        !telemetryEnabled || options.mock
          ? 'none'
          : isTerminalRun
            ? 'curl'
            : isAppRun
              ? 'mcp'
              : 'none',
      telemetryUrl: telemetryUrl(auth.region),
    });

    if (options.printPrompt) {
      // No handoff happens here — we only print the prompt — so this must not
      // fire a `start` event, which would inflate the funnel with runs that
      // never began.
      console.log(prompt);
      await telemetry.flush();
      return 0;
    }

    // 6. Hand off to the agent.
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

    // GUI apps only: set up the Subtext plugin before handing off, so the
    // agent has the subtext MCP tools the prompt relies on (telemetry,
    // session review).
    if (isAppRun) {
      const ready = await guidePluginSetup(chosen, auth.region);
      telemetry.note('plugin_setup', { agent: chosen.definition.id, ready });
    }

    if (isTerminalRun) {
      const confirmed = options.agent
        ? true
        : await p.confirm({
            message: `Run the install now with ${chosen.definition.name}? It will edit files in ${options.dir} (auto-accepting edits).`,
          });
      if (p.isCancel(confirmed) || !confirmed) throw new CancelledError();
      // GUI runs skip this: their agent logs its own start event (with
      // harness and model) through the MCP tool, per the prompt.
      sendStart(chosen.definition.id);
    }

    const result = await chosen.definition.launch({
      prompt,
      cwd: options.dir,
      binaryPath: chosen.binaryPath,
      debug: options.debug,
      // Terminal agents fire the per-step telemetry checkpoints themselves;
      // this token authenticates those curls. It is the user's own OAuth
      // access token, exposed only to a child process on their machine.
      env:
        isTerminalRun && telemetryEnabled && !options.mock
          ? { SUBTEXT_TELEMETRY_TOKEN: auth.accessToken }
          : undefined,
      onEvent: (event, properties) => telemetry.note(event, properties),
    });

    telemetry.note('wizard_completed', {
      agent: chosen.definition.id,
      mode: result.mode,
      exit_code: result.exitCode ?? null,
    });
    // On success the agent's own step-8 checkpoint is the complete event;
    // sending another here would double-count the funnel. A failed run can't
    // be trusted to have reported itself, so the wizard records it.
    if (result.mode === 'ran' && result.exitCode !== 0) {
      telemetry.step('complete', 'fail', { harness: chosen.definition.id });
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
    if (error instanceof CancelledError) {
      telemetry.finish('skipped');
      p.cancel('Setup cancelled — nothing was changed.');
      await telemetry.flush();
      return 130;
    }
    // The endpoint has no field for the error message itself (flagged for
    // review) — only the fail outcome goes up.
    telemetry.finish('fail');
    telemetry.note('wizard_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro(pc.red('Setup failed.'));
    await telemetry.flush();
    return 1;
  }
}
