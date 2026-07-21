import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runTerminalAgent, which } from './helpers.js';
import { makeMarkerLineFilter } from './telemetry-marker.js';
import type { AgentDefinition, LaunchContext, LaunchResult } from './types.js';

async function launch(ctx: LaunchContext): Promise<LaunchResult> {
  p.log.step('Running the Subtext install with Codex CLI…');
  p.log.info(pc.dim('Codex is doing the install in this terminal. Progress below.'));

  // `codex exec` is Codex's non-interactive mode; --full-auto lets it edit
  // files and run commands inside its workspace sandbox without prompting.
  // We pipe stdout (rather than inherit) so the wizard can pull telemetry
  // markers out of the stream; every other line is echoed through with the
  // shared agent-output styling (purple gutter bar).
  const exitCode = await runTerminalAgent({
    binaryPath: ctx.binaryPath!,
    args: ['exec', '--full-auto', ctx.prompt],
    cwd: ctx.cwd,
    stdout: 'pipe',
    onStdoutLine: makeMarkerLineFilter(ctx.onTelemetry),
  });
  return { mode: 'ran', exitCode };
}

export const codexCli: AgentDefinition = {
  id: 'codex',
  name: 'Codex CLI',
  kind: 'terminal',
  autonomy: 'auto-accepting file edits and commands inside its workspace sandbox',
  async detect() {
    const binaryPath = await which('codex');
    if (!binaryPath) return null;
    return { definition: codexCli, binaryPath, detail: binaryPath };
  },
  launch,
};
