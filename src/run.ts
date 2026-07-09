import * as p from '@clack/prompts';
import clipboard from 'clipboardy';
import pc from 'picocolors';
import { authenticate } from './auth.js';
import { chooseAgent, detectAgents, MANUAL_CHOICE } from './agents/index.js';
import type { WizardOptions } from './config.js';
import { WIZARD_VERSION } from './config.js';
import { CancelledError, selectIntegrations } from './integrations.js';
import { showLogo } from './logo.js';
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

  telemetry.capture('wizard_started', { mock: options.mock, dir_provided: options.dir !== process.cwd() });

  try {
    // 1. Login (browser flow) so we can fetch the org-specific snippet.
    const auth = await authenticate(options);
    telemetry.setTag('org_id', auth.orgId);
    telemetry.capture('auth_completed', { via: options.apiKey ? 'api_key' : 'browser' });

    // 2. Org-specific capture snippet.
    const snippet = await fetchCaptureSnippet(auth, options);
    telemetry.capture('snippet_fetched');

    // 3. Which integrations should the agent look for?
    const selection = await selectIntegrations(options);
    telemetry.capture('integrations_selected', {
      integrations: selection.integrations.map((i) => i.id),
      other: selection.other,
    });

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
    telemetry.capture('agents_detected', { agents: detected.map((d) => d.definition.id) });

    const chosen = await chooseAgent(detected, options);
    const isTerminalRun = chosen !== MANUAL_CHOICE && chosen.definition.kind === 'terminal';

    // 5. Assemble the install prompt. Terminal agents get the autonomous
    //    variant (no approval gates); app handoffs keep the interactive one.
    const prompt = buildInstallPrompt({
      snippet,
      selection,
      mode: isTerminalRun ? 'headless' : 'interactive',
      runId: telemetry.runId,
      telemetryEnabled: options.telemetry,
    });

    if (options.printPrompt) {
      telemetry.capture('prompt_printed');
      console.log(prompt);
      await telemetry.flush();
      return 0;
    }

    // 6. Hand off to the agent.
    if (chosen === MANUAL_CHOICE) {
      let copied = true;
      try {
        await clipboard.write(prompt);
      } catch {
        copied = false;
      }
      telemetry.capture('manual_handoff', { clipboard: copied });
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

    telemetry.capture('agent_launch_started', {
      agent: chosen.definition.id,
      kind: chosen.definition.kind,
    });

    if (isTerminalRun) {
      const confirmed = options.agent
        ? true
        : await p.confirm({
            message: `Run the install now with ${chosen.definition.name}? It will edit files in ${options.dir} (auto-accepting edits).`,
          });
      if (p.isCancel(confirmed) || !confirmed) throw new CancelledError();
    }

    const result = await chosen.definition.launch({
      prompt,
      cwd: options.dir,
      binaryPath: chosen.binaryPath,
      debug: options.debug,
      onEvent: (event, properties) => telemetry.capture(event, properties),
    });

    telemetry.capture('wizard_completed', {
      agent: chosen.definition.id,
      mode: result.mode,
      exit_code: result.exitCode ?? null,
    });

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
      telemetry.capture('wizard_cancelled');
      p.cancel('Setup cancelled — nothing was changed.');
      await telemetry.flush();
      return 130;
    }
    telemetry.captureError(error);
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro(pc.red('Setup failed.'));
    await telemetry.flush();
    return 1;
  }
}
