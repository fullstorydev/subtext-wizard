import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runTerminalAgent, sanitizeTerminalOutput, which } from './helpers.js';
import { printAgentText } from './output.js';
import type { AgentDefinition, LaunchContext, LaunchResult } from './types.js';

async function launch(ctx: LaunchContext): Promise<LaunchResult> {
  p.log.step('Running the Subtext install with Codex CLI…');
  p.log.info(pc.dim('Codex is doing the install in this terminal. Progress below.'));

  // `codex exec` is Codex's non-interactive mode; --full-auto lets it edit
  // files and run commands inside its workspace sandbox without prompting.
  // stdout is piped so every line gets the shared agent-output styling.
  const exitCode = await runTerminalAgent({
    binaryPath: ctx.binaryPath!,
    args: ['exec', '--full-auto', ctx.prompt],
    cwd: ctx.cwd,
    stdout: 'pipe',
    onStdoutLine: (line) => printAgentText(sanitizeTerminalOutput(line)),
  });
  return { mode: 'ran', exitCode };
}

export const codexCli: AgentDefinition = {
  id: 'codex',
  name: 'Codex CLI',
  kind: 'terminal',
  autonomy: 'auto-accepting file edits and commands inside its workspace sandbox',
  consent: 'edit files and run commands in its sandbox',
  async detect() {
    const binaryPath = await which('codex');
    if (!binaryPath) return null;
    return { definition: codexCli, binaryPath, detail: binaryPath };
  },
  launch,
};
