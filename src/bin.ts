#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WIZARD_VERSION, type WizardOptions } from './config.js';
import { runWizard } from './run.js';

const HELP = `
Subtext setup — install the Subtext capture snippet with your own coding agent.

Usage:
  npx @subtext/install [options]

Options:
  --dir <path>            App directory to instrument (default: current directory)
  --region <us|eu>        Data region for login and API hosts (default: us)
  --api-key <key>         Skip the browser login and use this OAuth access token
  --agent <id>            Skip the agent picker (claude-code, codex, gemini, cursor,
                          devin, vscode, zed, claude-desktop, manual)
  --integrations <list>   Comma-separated integrations to target, skips the picker
                          (posthog, amplitude, mixpanel, statsig, sentry, logrocket,
                          datadog, launchdarkly, growthbook, intercom, pendo, appcues,
                          userpilot, sprig, segment — unknown names become "Other")
  --print-prompt          Build and print the install prompt instead of launching
  --mock                  No real network calls (placeholder auth + snippet)
  --no-telemetry          Disable telemetry
  --debug                 Verbose output
  --version               Print version
  --help                  Show this help
`.trim();

function main(): void {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        dir: { type: 'string' },
        region: { type: 'string', default: 'us' },
        'api-key': { type: 'string' },
        agent: { type: 'string' },
        integrations: { type: 'string' },
        'print-prompt': { type: 'boolean', default: false },
        mock: { type: 'boolean', default: false },
        'no-telemetry': { type: 'boolean', default: false },
        debug: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${HELP}`);
    process.exit(2);
  }

  const { values } = parsed;
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(WIZARD_VERSION);
    return;
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) {
    console.error(`Subtext setup requires Node 18.17+, found ${process.version}.`);
    process.exit(1);
  }

  if (values.region !== 'us' && values.region !== 'eu') {
    console.error(`--region must be 'us' or 'eu', got '${values.region}'.`);
    process.exit(2);
  }

  const options: WizardOptions = {
    dir: path.resolve(values.dir ?? process.cwd()),
    region: values.region,
    apiKey: values['api-key'],
    agent: values.agent,
    integrations: values.integrations
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    printPrompt: values['print-prompt'] ?? false,
    mock: values.mock ?? false,
    telemetry: !(values['no-telemetry'] ?? false),
    debug: values.debug ?? false,
  };

  runWizard(options)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    });
}

main();
