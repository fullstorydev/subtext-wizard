import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { sanitizeTerminalOutput } from './agents/helpers.js';
import type { DetectedAgent, LaunchResult } from './agents/types.js';
import { buildStepPrompt, resultFile, type InstallStep, type StepContext } from './prompt/build.js';
import type { Telemetry, WorkflowEventMetadata, WorkflowOutcome, WorkflowStep } from './telemetry.js';

export type StepStatus = 'done' | 'skipped' | 'failed';

export interface StepResult {
  status: StepStatus;
  detail: string;
  filesChanged: string[];
}

export type StepResults = Partial<Record<InstallStep, StepResult>>;

const LABELS: Record<InstallStep, string> = {
  capture: 'Installing the snippet',
  csp: 'Updating the Content-Security-Policy',
  identify: 'Identifying users',
  integrations: 'Linking analytics tools',
  privacy: 'Masking sensitive data',
};

/**
 * The JSON an agent writes at the end of a step run, or undefined if it's
 * missing, left over from an earlier run, or malformed. Agent-written, so
 * every field is checked and every string sanitized before display.
 */
export function readStepResult(dir: string, step: InstallStep, since: number): StepResult | undefined {
  const file = path.join(dir, resultFile(step));
  try {
    if (fs.statSync(file).mtimeMs < since) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const { status, detail } = raw;
    if (status !== 'done' && status !== 'skipped' && status !== 'failed') return undefined;
    const files = Array.isArray(raw.files_changed) ? raw.files_changed : [];
    return {
      status,
      detail: typeof detail === 'string' ? clean(detail) : '',
      filesChanged: files.filter((f): f is string => typeof f === 'string').slice(0, 50).map(clean),
    };
  } catch {
    return undefined;
  }
}

function clean(text: string): string {
  const line = sanitizeTerminalOutput(text).replace(/\s+/g, ' ').trim();
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** A run that exited without writing its result still tells us something. */
function fallbackResult(run: LaunchResult): StepResult {
  return run.exitCode === 0
    ? { status: 'failed', detail: 'the agent did not report a result', filesChanged: [] }
    : { status: 'failed', detail: `the agent exited with code ${run.exitCode}`, filesChanged: [] };
}

export interface StepRunner {
  agent: DetectedAgent;
  dir: string;
  debug: boolean;
  telemetry: Telemetry;
  /** Dry run: don't launch anything. */
  dryRun?: boolean;
}

/** Launch a fresh agent for each step, in order, and collect what each reported. */
export async function runSteps(runner: StepRunner, steps: InstallStep[], ctx: StepContext): Promise<StepResults> {
  const results: StepResults = {};
  for (const step of steps) {
    if (runner.dryRun) {
      p.log.info(pc.dim(`--print-prompt: skipping the ${step} run.`));
      continue;
    }
    const startedAt = Date.now();
    const run = await runner.agent.definition.launch({
      prompt: buildStepPrompt(step, ctx),
      cwd: runner.dir,
      binaryPath: runner.agent.binaryPath,
      debug: runner.debug,
      label: LABELS[step],
      onEvent: (event, props) => runner.telemetry.note(event, props),
    });
    const result = readStepResult(runner.dir, step, startedAt) ?? fallbackResult(run);
    if (result.status !== 'done' && run.finalMessage) p.log.message(pc.dim(run.finalMessage));
    results[step] = result;
    // A failed snippet install means nothing after it can work.
    if (step === 'capture' && result.status === 'failed') break;
  }
  return results;
}

const OUTCOME: Record<StepStatus, WorkflowOutcome> = { done: 'success', skipped: 'skipped', failed: 'fail' };

/**
 * The backend only accepts its fixed WorkflowStep enum, so the per-page steps
 * map onto it: capture and csp together are `install`.
 */
export function reportSteps(
  telemetry: Telemetry,
  results: StepResults,
  meta: { harness: string; framework?: string; analyticsProviders?: string[] },
): void {
  const send = (step: WorkflowStep, result: StepResult, extra: WorkflowEventMetadata = {}) =>
    telemetry.step(step, OUTCOME[result.status], { ...extra, harness: meta.harness });

  if (results.capture || results.csp) {
    const install = results.capture ?? results.csp!;
    const failed = results.capture?.status === 'failed' || results.csp?.status === 'failed';
    send('install', failed ? { ...install, status: 'failed' } : install, {
      ...(meta.framework ? { framework: meta.framework } : {}),
      csp_modified: results.csp?.status === 'done',
    });
  }
  if (results.identify) send('identify', results.identify, { identity_added: results.identify.status === 'done' });
  if (results.integrations) {
    send('link_analytics', results.integrations, { analytics_providers: meta.analyticsProviders ?? [] });
  }
  if (results.privacy) send('mask_pii', results.privacy);
}

export function filesChanged(results: StepResults): string[] {
  return [...new Set(Object.values(results).flatMap((r) => r?.filesChanged ?? []))];
}
