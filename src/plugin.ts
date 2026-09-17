import * as p from '@clack/prompts';
import type { DetectedAgent } from './agents/types.js';
import { apiBaseUrl, type Region } from './config.js';
import { CancelledError } from './integrations.js';

/** Realm-aware Subtext MCP URL. The packaged plugin (fullstorydev/subtext)
 * ships the NA endpoint only; EU orgs must use this URL as a raw server.
 * HTTP only — no local process required. */
export function subtextMcpUrl(region: Region): string {
  return `${apiBaseUrl(region)}/mcp/subtext`;
}

/** Per-agent install steps, following the fullstorydev/subtext README. Agents
 * without a store listing get the manual openskills + MCP-config path. The
 * marketplace plugin is NA-only — EU orgs get the raw EU URL instead. */
function instructions(agentId: string, agentName: string, mcpUrl: string, region: Region): string {
  if (region === 'eu') {
    switch (agentId) {
      case 'cursor':
        return [
          'This org is in the EU data region. The Subtext marketplace plugin only includes the NA MCP server.',
          'Add the EU MCP server in Cursor Settings → MCP:',
          mcpUrl,
        ].join('\n');
      case 'claude-desktop':
        return [
          'This org is in the EU data region. The Subtext plugin only includes the NA MCP server.',
          'In Claude Desktop, open Settings → Connectors → “Add custom connector”',
          `and add the EU MCP server:\n${mcpUrl}`,
        ].join('\n');
      default:
        return [
          'This org is in the EU data region. The Subtext plugin only includes the NA MCP server.',
          'Install the Subtext skills:  npx openskills install fullstorydev/subtext',
          `Then add the EU MCP server to ${agentName}'s MCP settings:\n${mcpUrl}`,
        ].join('\n');
    }
  }

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
 * section relies on. EU orgs skip the marketplace plugin (NA MCP only) and
 * add the EU server by hand. Declining is fine: the install prompt treats a
 * missing tool as "skip telemetry silently".
 */
export async function guidePluginSetup(agent: DetectedAgent, region: Region): Promise<boolean> {
  const name = agent.definition.name;
  const mcpUrl = subtextMcpUrl(region);
  if (region === 'eu') {
    p.log.step(
      `First, add the EU Subtext MCP server in ${name} — the marketplace plugin only includes the NA server.`,
    );
  } else {
    p.log.step(
      `First, set up the Subtext plugin in ${name} — it gives the agent Subtext's skills and MCP tools.`,
    );
  }
  p.note(instructions(agent.definition.id, name, mcpUrl, region), 'Subtext plugin setup');
  const done = await p.confirm({
    message:
      region === 'eu'
        ? `Is the EU Subtext MCP server added in ${name}? ("No" continues without it — the install still works.)`
        : `Is the Subtext plugin set up in ${name}? ("No" continues without it — the install still works.)`,
  });
  if (p.isCancel(done)) throw new CancelledError();
  if (!done) {
    p.log.info(
      region === 'eu'
        ? 'Continuing without the EU MCP server — the agent will skip anything that needs it.'
        : 'Continuing without the plugin — the agent will skip anything that needs it.',
    );
  }
  return done;
}
