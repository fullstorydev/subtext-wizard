import * as p from '@clack/prompts';
import type { DetectedAgent } from './agents/types.js';
import { apiBaseUrl, type Region } from './config.js';
import { CancelledError } from './integrations.js';

/** Remote MCP server bundled with the Subtext plugin (fullstorydev/subtext).
 * HTTP only — no local process required. */
export function subtextMcpUrl(region: Region): string {
  return `${apiBaseUrl(region)}/mcp/subtext`;
}

/** Per-agent install steps, following the fullstorydev/subtext README. Agents
 * without a store listing get the manual openskills + MCP-config path. */
function instructions(agentId: string, agentName: string, mcpUrl: string): string {
  switch (agentId) {
    case 'cursor':
      return [
        'In Cursor, open the plugin Marketplace panel and install “Subtext”',
        '(or add the fullstorydev/subtext repo as a marketplace).',
      ].join('\n');
    case 'claude-desktop':
      return [
        'In Claude Desktop, open Settings → Connectors → “Add custom connector”',
        `and add the Subtext MCP server:\n${mcpUrl}`,
      ].join('\n');
    default:
      return [
        'Install the Subtext skills:  npx openskills install fullstorydev/subtext',
        `Then add the subtext MCP server to ${agentName}'s MCP settings:\n${mcpUrl}`,
      ].join('\n');
  }
}

/**
 * Walk the user through installing the Subtext plugin in their GUI agent
 * before we hand off. The plugin gives the agent Subtext's skills and MCP
 * tools — including `telemetry-event`, which the handoff prompt's telemetry
 * section relies on. Declining is fine: the install prompt treats a missing
 * tool as "skip telemetry silently".
 */
export async function guidePluginSetup(agent: DetectedAgent, region: Region): Promise<boolean> {
  const name = agent.definition.name;
  p.log.step(
    `First, set up the Subtext plugin in ${name} — it gives the agent Subtext's skills and MCP tools.`,
  );
  p.note(instructions(agent.definition.id, name, subtextMcpUrl(region)), 'Subtext plugin setup');
  const done = await p.confirm({
    message: `Is the Subtext plugin set up in ${name}? ("No" continues without it — the install still works.)`,
  });
  if (p.isCancel(done)) throw new CancelledError();
  if (!done) {
    p.log.info('Continuing without the plugin — the agent will skip anything that needs it.');
  }
  return done;
}
