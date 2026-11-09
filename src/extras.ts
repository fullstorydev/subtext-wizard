import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { IntegrationSelection } from './integrations.js';
import { readableNoteBody } from './logo.js';
import { filesChanged, type StepResult, type StepResults } from './steps.js';

/**
 * The optional extras pass (identify users, link analytics, mask PII): the
 * analytics pre-check that scopes the agent runs, and the summary the
 * wizard prints from each step's result instead of ending on raw agent output.
 */

/** Where headless runs leave their reports, relative to the project. */
export const SUBTEXT_DIR = '.subtext';

export interface ExtrasScope {
  selection: IntegrationSelection;
}

/** One box saying what the pass will do, shown before asking to run it. */
export function showExtrasPlan(scope: ExtrasScope): void {
  const tools = [...scope.selection.integrations.map((i) => i.label), ...scope.selection.other];
  const rows = [
    row('Identity', 'tie sessions to signed-in users, if the app has sign-in'),
    row('Analytics', tools.length > 0 ? `link session URLs into ${tools.join(', ')}` : 'none found, skipped'),
    row('Masking', 'tag fields that show personal data'),
  ];
  p.note(readableNoteBody(rows.join('\n')), 'Optional extras');
}

const LABEL_WIDTH = 11;

function row(label: string, text: string): string {
  return `${pc.bold(label.padEnd(LABEL_WIDTH))}${text}`;
}

function statusRow(label: string, item: StepResult | undefined): string {
  if (!item) return `${pc.dim('?')} ${row(label, pc.dim('not reported'))}`;
  const mark = item.status === 'done' ? pc.green('✔') : item.status === 'failed' ? pc.yellow('!') : pc.dim('–');
  const text = item.status === 'done' ? item.detail || 'done' : `${item.status}${item.detail ? `: ${item.detail}` : ''}`;
  return `${mark} ${row(label, item.status === 'done' ? text : pc.dim(text))}`;
}

export function showExtrasResults(results: StepResults): void {
  const rows = [
    `${pc.green('✔')} ${row('Snippet', 'installed')}`,
    statusRow('Identity', results.identify),
    statusRow('Analytics', results.integrations),
    statusRow('Masking', results.privacy),
  ];
  const changed = filesChanged(results);
  if (changed.length > 0) {
    const shown = changed.slice(0, 5).join(', ');
    const more = changed.length > 5 ? ` +${changed.length - 5} more` : '';
    rows.push('', pc.dim(`Changed: ${shown}${more}`));
  }
  p.note(readableNoteBody(rows.join('\n')), 'Results');
}
