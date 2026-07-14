import clipboard from 'clipboardy';
import * as p from '@clack/prompts';
import { macAppPath, openAppAtDir, which } from './helpers.js';
import type { AgentDefinition, LaunchContext, LaunchResult } from './types.js';

interface AppAgentSpec {
  id: string;
  name: string;
  /** CLI launcher command, if the app installs one (e.g. `cursor`, `code`). */
  cliCommand?: string;
  /** macOS app bundle name. */
  macAppName?: string;
  /** Whether launching should pass the project directory. */
  opensFolder: boolean;
  /** Where to paste the prompt inside the app. */
  pasteHint: string[];
}

/**
 * GUI agents can't run our prompt headlessly, so the strategy is:
 * copy the prompt to the clipboard, open the app at the project folder,
 * and tell the user exactly where to paste.
 */
function makeAppAgent(spec: AppAgentSpec): AgentDefinition {
  const definition: AgentDefinition = {
    id: spec.id,
    name: spec.name,
    kind: 'app',
    async detect() {
      const binaryPath = spec.cliCommand ? await which(spec.cliCommand) : null;
      const appPath = spec.macAppName ? macAppPath(spec.macAppName) : null;
      if (!binaryPath && !appPath) return null;
      return {
        definition,
        binaryPath: binaryPath ?? undefined,
        detail: binaryPath ?? appPath ?? undefined,
      };
    },
    async launch(ctx: LaunchContext): Promise<LaunchResult> {
      let copied = true;
      try {
        await clipboard.write(ctx.prompt);
      } catch {
        copied = false;
      }

      let opened = true;
      try {
        await openAppAtDir({
          binaryPath: ctx.binaryPath,
          macAppName: spec.macAppName,
          dir: spec.opensFolder ? ctx.cwd : undefined,
        });
      } catch {
        opened = false;
      }

      const followUp: string[] = [];
      if (opened) {
        followUp.push(
          spec.opensFolder
            ? `${spec.name} is opening at ${ctx.cwd}.`
            : `${spec.name} is opening.`,
        );
      } else {
        followUp.push(
          `Couldn't launch ${spec.name} automatically — open it yourself${
            spec.opensFolder ? ` at ${ctx.cwd}` : ''
          }.`,
        );
      }
      followUp.push(
        copied
          ? 'The Subtext install prompt is on your clipboard.'
          : 'Clipboard copy failed — the full prompt is printed below; copy it manually.',
      );
      followUp.push(...spec.pasteHint);
      followUp.push('The agent will walk you through the install and ask for approval before changing code.');

      if (!copied) {
        // Make sure the user can still get the prompt.
        p.log.message(ctx.prompt);
      }
      return { mode: 'handoff', followUp };
    },
  };
  return definition;
}

export const cursor = makeAppAgent({
  id: 'cursor',
  name: 'Cursor',
  cliCommand: 'cursor',
  macAppName: 'Cursor',
  opensFolder: true,
  pasteHint: ['Open the agent pane (Cmd+I / Ctrl+I) and paste the prompt.'],
});

// Windsurf became Devin Desktop after Cognition's acquisition (June 2026):
// same editor, `devin-desktop` shell command, Devin.app bundle on macOS.
export const devin = makeAppAgent({
  id: 'devin',
  name: 'Devin Desktop',
  cliCommand: 'devin-desktop',
  macAppName: 'Devin',
  opensFolder: true,
  pasteHint: ['Open the agent panel (Cascade, Cmd+L / Ctrl+L) and paste the prompt.'],
});

export const vscode = makeAppAgent({
  id: 'vscode',
  name: 'VS Code (Copilot agent mode)',
  cliCommand: 'code',
  macAppName: 'Visual Studio Code',
  opensFolder: true,
  pasteHint: [
    'Open Copilot Chat (Cmd+Shift+I / Ctrl+Shift+I), switch to Agent mode, and paste the prompt.',
  ],
});

export const zed = makeAppAgent({
  id: 'zed',
  name: 'Zed',
  cliCommand: 'zed',
  macAppName: 'Zed',
  opensFolder: true,
  pasteHint: ['Open the Agent Panel (Cmd+? in Zed) and paste the prompt.'],
});

export const claudeDesktop = makeAppAgent({
  id: 'claude-desktop',
  name: 'Claude Desktop',
  macAppName: 'Claude',
  opensFolder: false,
  pasteHint: [
    'Start a new chat, paste the prompt, and make sure Claude has access to this project folder',
    "(via Claude's file/folder access or an MCP filesystem connector pointed at the project directory).",
  ],
});
