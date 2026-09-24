#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  WIZARD_VERSION,
  telemetryOptedOutByEnv,
  warnOnDevOverrides,
  type WizardOptions,
} from './config.js';
import { runWizard } from './run.js';

const HELP = `
Subtext setup — install the Subtext capture snippet with your own coding agent.

Usage:
  npx @subtextdev/subtext-wizard [options]

Options:
  --dir <path>            App directory to instrument (default: current directory)
  --api-key <key>         Skip the browser login and authenticate with this
                          credential: a Fullstory API key or an OAuth access
                          token (auto-detected). Prefer the SUBTEXT_API_KEY env
                          var — an --api-key on the command line lands in shell
                          history and is visible to other local users via the
                          process list.
  --api-key-oauth <token> Like --api-key, but always treats the value as an
                          OAuth access token (the wizard's original behavior).
                          Env var: SUBTEXT_API_KEY_OAUTH. Mutually exclusive
                          with --api-key.
  --agent <id>            Skip the agent picker (claude-code, codex, gemini, cursor,
                          windsurf, vscode, zed, claude-desktop, manual)
  --integrations <list>   Comma-separated integrations to target, skips the picker
                          (posthog, amplitude, mixpanel, statsig, sentry, logrocket,
                          datadog, launchdarkly, growthbook, intercom, pendo, appcues,
                          userpilot, sprig, segment — unknown names become "Other")
  --print-prompt          Print each install prompt to stdout as it's built, then
                          continue the normal flow (testing aid)
  --yes                   Skip the pre-launch confirmation (for CI/non-interactive
                          use). The agent runs autonomously against --dir with
                          edits — and, depending on the agent, command execution —
                          auto-approved. Only pass this in a trusted directory.
  --mock                  No real network calls (placeholder auth + snippet)
  --no-telemetry          Opt out of telemetry. Anonymous install telemetry
                          (step progress, outcomes, timings, and agent token
                          usage — never your code or data) is ON by default;
                          this flag, or DO_NOT_TRACK=1 / DISABLE_TELEMETRY=1,
                          turns it off.
  --debug                 Verbose output
  --version               Print version
  --help                  Show this help
`.trim();

function main(): void {
  // Surface any SUBTEXT_*_URL override (honored or ignored) before anything
  // else runs, so a poisoned project env can never redirect a run silently.
  warnOnDevOverrides();

  let parsed;
  try {
    parsed = parseArgs({
      options: {
        dir: { type: 'string' },
        'api-key': { type: 'string' },
        'api-key-oauth': { type: 'string' },
        agent: { type: 'string' },
        integrations: { type: 'string' },
        'print-prompt': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
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

  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 18 || (nodeMajor === 18 && nodeMinor < 17)) {
    console.error(`Subtext setup requires Node 18.17+, found ${process.version}.`);
    process.exit(1);
  }

  // --api-key auto-detects a Fullstory API key vs an OAuth access token;
  // --api-key-oauth forces the OAuth-token path (the wizard's original
  // --api-key behavior). The two flags are mutually exclusive.
  if (values['api-key'] && values['api-key-oauth']) {
    console.error('Pass only one of --api-key or --api-key-oauth, not both.');
    process.exit(2);
  }
  const mock = values.mock ?? false;
  const { apiKey, apiKeyKind } = resolveCredential(values, mock);

  const options: WizardOptions = {
    dir: path.resolve(values.dir ?? process.cwd()),
    // EU is not supported yet; default to the US region. The --region flag is
    // intentionally not exposed until EU support ships.
    region: 'us',
    apiKey,
    apiKeyKind,
    agent: values.agent,
    integrations: values.integrations
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    printPrompt: values['print-prompt'] ?? false,
    yes: values.yes ?? false,
    mock,
    // Telemetry is on by default; both the explicit --no-telemetry flag and the
    // standard DO_NOT_TRACK / DISABLE_TELEMETRY env vars opt out. The env-var
    // opt-out is honored silently here (no prompt, no network call downstream).
    telemetry: !(values['no-telemetry'] ?? false) && !telemetryOptedOutByEnv(),
    debug: values.debug ?? false,
  };

  runWizard(options)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    });
}

/**
 * Resolve which credential the wizard authenticates with, and how. Flags beat
 * env vars so a credential need not appear in argv (shell history / process
 * list); the -oauth forms force the OAuth-token path, the plain forms
 * auto-detect. Under --mock the env vars are ignored entirely — a
 * SUBTEXT_API_KEY* left in the shell would otherwise be validated (and could
 * reject) or short-circuit the canned mock auth. An explicit flag is still
 * honored under --mock for anyone testing that path on purpose.
 */
function resolveCredential(
  values: { 'api-key'?: string; 'api-key-oauth'?: string },
  mock: boolean,
): { apiKey?: string; apiKeyKind: 'auto' | 'oauth' } {
  if (values['api-key-oauth']) return { apiKey: values['api-key-oauth'], apiKeyKind: 'oauth' };
  if (values['api-key']) return { apiKey: values['api-key'], apiKeyKind: 'auto' };
  if (mock) return { apiKeyKind: 'auto' };
  if (process.env.SUBTEXT_API_KEY_OAUTH)
    return { apiKey: process.env.SUBTEXT_API_KEY_OAUTH, apiKeyKind: 'oauth' };
  if (process.env.SUBTEXT_API_KEY) return { apiKey: process.env.SUBTEXT_API_KEY, apiKeyKind: 'auto' };
  return { apiKeyKind: 'auto' };
}

main();
