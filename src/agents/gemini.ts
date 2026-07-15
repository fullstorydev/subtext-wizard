import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runTerminalAgent, which } from './helpers.js';
import { makeMarkerLineFilter } from './telemetry-marker.js';
import type { AgentDefinition, LaunchContext, LaunchResult } from './types.js';

async function launch(ctx: LaunchContext): Promise<LaunchResult> {
  p.log.step('Running the Subtext install with Gemini CLI…');
  p.log.info(pc.dim('Gemini is doing the install in this terminal. Progress below.'));

  // -p runs non-interactively; --yolo auto-approves tool calls. We pipe stdout
  // (rather than inherit) so the wizard can pull telemetry markers out of the
  // stream; every other line is echoed through unchanged.
  const exitCode = await runTerminalAgent({
    binaryPath: ctx.binaryPath!,
    args: ['--yolo', '-p', ctx.prompt],
    cwd: ctx.cwd,
    stdout: 'pipe',
    onStdoutLine: makeMarkerLineFilter(ctx.onTelemetry),
  });
  return { mode: 'ran', exitCode };
}

export const geminiCli: AgentDefinition = {
  id: 'gemini',
  name: 'Gemini CLI',
  kind: 'terminal',
  async detect() {
    const binaryPath = await which('gemini');
    if (!binaryPath) return null;
    return { definition: geminiCli, binaryPath, detail: binaryPath };
  },
  launch,
};
