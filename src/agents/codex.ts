import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runTerminalAgent, which } from './helpers.js';
import type { AgentDefinition, LaunchContext, LaunchResult } from './types.js';

async function launch(ctx: LaunchContext): Promise<LaunchResult> {
  p.log.step('Running the Subtext install with Codex CLI…');
  p.log.info(pc.dim('Codex is doing the install in this terminal. Progress below.'));

  // `codex exec` is Codex's non-interactive mode; --full-auto lets it edit
  // files and run commands inside its workspace sandbox without prompting.
  const exitCode = await runTerminalAgent({
    binaryPath: ctx.binaryPath!,
    args: ['exec', '--full-auto', ctx.prompt],
    cwd: ctx.cwd,
    env: ctx.env,
    stdout: 'inherit',
  });
  return { mode: 'ran', exitCode };
}

export const codexCli: AgentDefinition = {
  id: 'codex',
  name: 'Codex CLI',
  kind: 'terminal',
  async detect() {
    const binaryPath = await which('codex');
    if (!binaryPath) return null;
    return { definition: codexCli, binaryPath, detail: binaryPath };
  },
  launch,
};
