import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { detectAgents } from './agents/index.js';
import type { DetectedAgent, LaunchResult } from './agents/types.js';
import { authenticate, type SubtextAuth } from './auth.js';
import type { WizardOptions } from './config.js';
import { telemetryUrl } from './config.js';
import {
  SUBTEXT_DIR,
  detectAuthLibraries,
  readExtrasResults,
  showExtrasResults,
  type ExtrasResults,
} from './extras.js';
import { detectInstalledIntegrations, selectIntegrations } from './integrations.js';
import { buildEnrichPrompt, buildSnippetPrompt, type PromptTelemetry } from './prompt/build.js';
import { fetchCaptureSnippet } from './snippet.js';
import { runStaticInstall, type StaticOutcome } from './staticInstall/index.js';
import { Telemetry } from './telemetry.js';

/**
 * --headless: configure the codebase with no human in the loop, for the
 * GitHub integration that runs the wizard inside a customer's repo with
 * credentials it already holds. Only code changes: the snippet (and any CSP
 * it needs), then the extras pass (identity, analytics linkage, privacy
 * masking). No browser, prompts, plugin setup, demo, or clipboard.
 *
 * The outcome is written to `.subtext/install-result.json` for the caller,
 * and the exit code is 0 only when the snippet ended up installed.
 */

export const INSTALL_RESULT = `${SUBTEXT_DIR}/install-result.json`;

type SnippetMethod = 'static' | 'agent' | 'already-installed';

interface InstallResult {
  snippet:
    | { status: 'installed'; method: SnippetMethod; file?: string; framework?: string }
    | { status: 'failed' | 'pending'; reason: string };
  extras:
    | { status: 'done'; results: Omit<ExtrasResults, 'filesChanged'>; files_changed: string[] }
    | { status: 'skipped' | 'failed' | 'pending'; reason: string };
  agent: string | null;
}

export async function runHeadless(options: WizardOptions): Promise<number> {
  const telemetry = new Telemetry(options.telemetry, options.debug);
  const finish = async (result: InstallResult, code: number): Promise<number> => {
    writeResult(options.dir, result);
    p.log.info(`Wrote ${INSTALL_RESULT}`);
    await telemetry.flush();
    return code;
  };

  if (!options.apiKey && !options.mock && !options.org) {
    p.log.error('--headless needs a credential (--api-key or SUBTEXT_API_KEY) or --org.');
    return 2;
  }

  p.log.message(`Subtext headless install in ${options.dir}`);
  let agent: DetectedAgent | undefined;
  try {
    // The snippet service is public, so a known org id is all it takes. No
    // credential means no telemetry either; the endpoint needs auth.
    const auth: SubtextAuth = options.org
      ? { accessToken: '', authScheme: 'Bearer', orgId: options.org, region: options.org.endsWith('-eu1') ? 'eu' : options.region }
      : await authenticate(options, false);
    const snippet = await fetchCaptureSnippet(auth, options);
    if (options.telemetry && !options.mock && !options.org) {
      telemetry.authorize(telemetryUrl(auth.region), auth.accessToken, auth.authScheme);
    }

    if (options.externalAgent) {
      const staticOutcome = await runStaticInstall(snippet, { ...options, yes: true }, (event, props) =>
        telemetry.note(event, props),
      );
      return finish(writeAgentPrompt(options, snippet, staticOutcome), 0);
    }

    agent = await pickTerminalAgent(options);
    const harness = agent?.definition.id ?? 'headless';
    telemetry.step('start', undefined, { harness });
    const promptTelemetry: PromptTelemetry = options.telemetry && !options.mock && agent ? 'stdout' : 'none';
    const launch = (prompt: string, label: string) => launchAgent(agent!, prompt, label, options, telemetry);

    // 1. The snippet: written directly when the framework is recognized, by
    //    the agent otherwise (which also covers CSP changes).
    const staticOutcome: StaticOutcome = await runStaticInstall(snippet, { ...options, yes: true }, (event, props) =>
      telemetry.note(event, props),
    );
    let snippetResult: InstallResult['snippet'];
    if (staticOutcome.status === 'installed') {
      snippetResult = { status: 'installed', method: 'static', file: staticOutcome.file, framework: staticOutcome.framework };
      telemetry.step('install', 'success', { framework: staticOutcome.framework, harness });
    } else if (staticOutcome.status === 'already-installed') {
      snippetResult = { status: 'installed', method: 'already-installed', file: staticOutcome.file };
      telemetry.step('precheck', 'success', { already_installed: true, harness });
    } else if (!agent) {
      snippetResult = {
        status: 'failed',
        reason: `automatic install not possible (${staticOutcome.reason}) and no coding agent CLI is available`,
      };
    } else {
      p.log.info(`Automatic install not possible (${staticOutcome.reason}); using ${agent.definition.name}.`);
      const run = await launch(buildSnippetPrompt({ snippet, mode: 'headless', telemetry: promptTelemetry }), 'Installing the snippet');
      snippetResult =
        run.exitCode === 0
          ? { status: 'installed', method: 'agent' }
          : { status: 'failed', reason: `${agent.definition.name} exited with code ${run.exitCode}` };
    }

    if (snippetResult.status === 'failed') {
      p.log.error(snippetResult.reason);
      telemetry.step('complete', 'fail', { harness });
      return finish({ snippet: snippetResult, extras: { status: 'skipped', reason: 'snippet not installed' }, agent: agent?.definition.id ?? null }, 1);
    }

    // 2. Extras: identity, analytics linkage, privacy masking. Needs an agent;
    //    without one the snippet still stands and the run succeeds.
    let extras: InstallResult['extras'];
    if (!agent) {
      extras = { status: 'skipped', reason: 'no coding agent CLI is available' };
    } else {
      const selection = options.integrations
        ? await selectIntegrations(options)
        : { integrations: detectInstalledIntegrations(options.dir), other: [] };
      const prompt = buildEnrichPrompt({
        selection,
        authLibraries: detectAuthLibraries(options.dir),
        mode: 'headless',
        telemetry: promptTelemetry,
      });
      const startedAt = Date.now();
      const run = await launch(prompt, 'Adding identity, analytics, and privacy');
      const results = readExtrasResults(options.dir, startedAt);
      if (results) {
        showExtrasResults(results);
        const { filesChanged, ...rest } = results;
        extras = { status: 'done', results: rest, files_changed: filesChanged };
      } else {
        extras = {
          status: 'failed',
          reason: run.exitCode === 0 ? 'the agent did not write a result file' : `the agent exited with code ${run.exitCode}`,
        };
      }
    }

    telemetry.step('complete', extras.status === 'done' ? 'success' : 'partial', { harness });
    return finish({ snippet: snippetResult, extras, agent: agent?.definition.id ?? null }, 0);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    p.log.error(reason);
    telemetry.finish('fail', agent ? { harness: agent.definition.id } : {});
    return finish({ snippet: { status: 'failed', reason }, extras: { status: 'skipped', reason: 'run failed' }, agent: agent?.definition.id ?? null }, 1);
  }
}

export const AGENT_PROMPT = `${SUBTEXT_DIR}/agent-prompt.md`;

/**
 * --external-agent: the deterministic part is done; leave the agent work as a
 * prompt file for an agent that's already running and invoked the wizard (a
 * hosted session), rather than spawning a CLI of our own.
 */
function writeAgentPrompt(options: WizardOptions, snippet: string, outcome: StaticOutcome): InstallResult {
  const parts: string[] = [];
  let snippetResult: InstallResult['snippet'];
  if (outcome.status === 'installed') {
    snippetResult = { status: 'installed', method: 'static', file: outcome.file, framework: outcome.framework };
  } else if (outcome.status === 'already-installed') {
    snippetResult = { status: 'installed', method: 'already-installed', file: outcome.file };
  } else {
    snippetResult = { status: 'pending', reason: outcome.reason };
    parts.push(`# Part 1: install the capture snippet\n\n${buildSnippetPrompt({ snippet, mode: 'headless', telemetry: 'none' })}`);
  }
  const extrasPrompt = buildEnrichPrompt({
    selection: { integrations: detectInstalledIntegrations(options.dir), other: [] },
    authLibraries: detectAuthLibraries(options.dir),
    mode: 'headless',
    telemetry: 'none',
  });
  parts.push(`# ${parts.length > 0 ? 'Part 2' : 'Task'}: identity, analytics, and privacy\n\n${extrasPrompt}`);

  fs.mkdirSync(path.join(options.dir, SUBTEXT_DIR), { recursive: true });
  fs.writeFileSync(path.join(options.dir, AGENT_PROMPT), parts.join('\n\n---\n\n'));
  p.log.info(`Wrote ${AGENT_PROMPT} for the agent to follow.`);
  return { snippet: snippetResult, extras: { status: 'pending', reason: `see ${AGENT_PROMPT}` }, agent: 'external' };
}

/** --agent if given (must be a terminal agent), else the first terminal agent found. */
async function pickTerminalAgent(options: WizardOptions): Promise<DetectedAgent | undefined> {
  const terminal = (await detectAgents()).filter((d) => d.definition.kind === 'terminal');
  if (options.agent) {
    const match = terminal.find((d) => d.definition.id === options.agent);
    if (!match) throw new Error(`--agent ${options.agent} is not an installed terminal agent (claude-code, codex, gemini).`);
    return match;
  }
  return terminal[0];
}

async function launchAgent(
  agent: DetectedAgent,
  prompt: string,
  label: string,
  options: WizardOptions,
  telemetry: Telemetry,
): Promise<LaunchResult> {
  // Untrusted stream: one event per step, first marker wins, harness stamped last.
  const sent = new Set<string>();
  return agent.definition.launch({
    prompt,
    cwd: options.dir,
    binaryPath: agent.binaryPath,
    debug: options.debug,
    label,
    onEvent: (event, props) => telemetry.note(event, props),
    onTelemetry: ({ step, outcome, metadata }) => {
      if (sent.has(step)) return;
      sent.add(step);
      telemetry.step(step, outcome, { ...metadata, harness: agent.definition.id });
    },
  });
}

function writeResult(dir: string, result: InstallResult): void {
  try {
    fs.mkdirSync(path.join(dir, SUBTEXT_DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, INSTALL_RESULT), `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    p.log.warn(`Could not write ${INSTALL_RESULT}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
