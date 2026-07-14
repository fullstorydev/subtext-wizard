import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { WizardOptions } from '../config.js';
import { CancelledError } from '../integrations.js';
import { claudeDesktop, cursor, devin, vscode, zed } from './apps.js';
import { claudeCode } from './claude-code.js';
import { codexCli } from './codex.js';
import { geminiCli } from './gemini.js';
import type { AgentDefinition, DetectedAgent } from './types.js';

/** Ordered by preference: terminal agents first (fully automated), then apps. */
export const AGENTS: AgentDefinition[] = [
  claudeCode,
  codexCli,
  geminiCli,
  cursor,
  devin,
  vscode,
  zed,
  claudeDesktop,
];

export async function detectAgents(): Promise<DetectedAgent[]> {
  const results = await Promise.all(AGENTS.map((agent) => agent.detect().catch(() => null)));
  return results.filter((r): r is DetectedAgent => r !== null);
}

/** Sentinel returned when the user wants the raw prompt instead of a launch. */
export const MANUAL_CHOICE = 'manual';

export async function chooseAgent(
  detected: DetectedAgent[],
  options: WizardOptions,
): Promise<DetectedAgent | typeof MANUAL_CHOICE> {
  if (options.agent) {
    const match = detected.find((d) => d.definition.id === options.agent);
    if (match) return match;
    if (options.agent === MANUAL_CHOICE) return MANUAL_CHOICE;
    throw new Error(
      `Agent '${options.agent}' was not detected. Detected: ${
        detected.map((d) => d.definition.id).join(', ') || 'none'
      }.`,
    );
  }

  if (detected.length === 0) {
    p.log.warn(
      'No coding agent detected (looked for Claude Code, Codex CLI, Gemini CLI, Cursor, Devin Desktop, VS Code, Zed, Claude Desktop).',
    );
    return MANUAL_CHOICE;
  }

  const choice = await p.select({
    message: 'Which coding agent should run the install?',
    options: [
      ...detected.map((d) => ({
        value: d.definition.id,
        label: d.definition.name,
        hint:
          d.definition.kind === 'terminal'
            ? 'runs automatically in this terminal'
            : 'opens the app — you paste the prompt',
      })),
      {
        value: MANUAL_CHOICE,
        label: 'None of these — just give me the prompt',
        hint: 'copies the prompt so you can use any tool',
      },
    ],
  });
  if (p.isCancel(choice)) throw new CancelledError();
  if (choice === MANUAL_CHOICE) return MANUAL_CHOICE;

  const chosen = detected.find((d) => d.definition.id === choice)!;
  if (chosen.detail) {
    p.log.info(pc.dim(`Using ${chosen.definition.name} at ${chosen.detail}`));
  }
  return chosen;
}
