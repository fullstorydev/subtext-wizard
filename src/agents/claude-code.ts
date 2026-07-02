import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { firstExistingPath, runTerminalAgent, which } from './helpers.js';
import type { AgentDefinition, LaunchContext, LaunchResult } from './types.js';

/**
 * Tools the headless run is pre-authorized to use beyond edits:
 * docs fetching, dependency installs, and the background telemetry curls
 * the prompt asks for. Everything else falls back to Claude Code's own
 * permission rules.
 */
const ALLOWED_TOOLS = [
  'WebFetch',
  'Bash(curl:*)',
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
            console.log(pc.dim(block.text.trim()));
          } else if (block.type === 'tool_use') {
            console.log(pc.dim(`  → ${describeToolUse(block.name, block.input)}`));
            ctx.onEvent?.('agent_tool_use', { tool: block.name });
          }
        }
      } else if (event.type === 'result') {
        resultText = event.result;
      }
    },
  });

  if (resultText) {
    p.note(resultText, 'Claude Code result');
  }
  return { mode: 'ran', exitCode };
}

export const claudeCode: AgentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'terminal',
  async detect() {
    const binaryPath = await findClaudeBinary();
    if (!binaryPath) return null;
    return { definition: claudeCode, binaryPath, detail: binaryPath };
  },
  launch,
};
