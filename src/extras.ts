import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { IntegrationSelection } from './integrations.js';
import { readableNoteBody } from './logo.js';
import { filesChanged, type StepResult, type StepResults } from './steps.js';

/**
 * The optional extras pass (identify users, link analytics, mask PII): the
 * cheap package.json pre-check that scopes the agent runs, and the summary the
 * wizard prints from each step's result instead of ending on raw agent output.
 */

/** Where headless runs leave their reports, relative to the project. */
export const SUBTEXT_DIR = '.subtext';

const AUTH_PACKAGES: Array<[string, string[]]> = [
  ['NextAuth / Auth.js', ['next-auth', '@auth/core', '@auth/nextjs', '@auth/sveltekit']],
  ['Clerk', ['@clerk/nextjs', '@clerk/clerk-react', '@clerk/clerk-js', '@clerk/remix', '@clerk/astro', '@clerk/vue']],
  ['Supabase', ['@supabase/supabase-js', '@supabase/ssr', '@supabase/auth-helpers-nextjs']],
  ['Firebase', ['firebase']],
  ['Auth0', ['@auth0/nextjs-auth0', '@auth0/auth0-react', '@auth0/auth0-spa-js', '@auth0/auth0-vue']],
  ['Amplify', ['aws-amplify', '@aws-amplify/auth']],
  ['Better Auth', ['better-auth']],
  ['Lucia', ['lucia']],
  ['Kinde', ['@kinde-oss/kinde-auth-nextjs', '@kinde-oss/kinde-auth-react']],
  ['WorkOS', ['@workos-inc/authkit-nextjs', '@workos-inc/authkit-react']],
  ['Stytch', ['@stytch/nextjs', '@stytch/react', '@stytch/vanilla-js']],
  ['Descope', ['@descope/react-sdk', '@descope/nextjs-sdk']],
  ['Okta', ['@okta/okta-auth-js', '@okta/okta-react']],
  ['Privy', ['@privy-io/react-auth']],
  ['Passport', ['passport']],
  ['iron-session', ['iron-session']],
];

export function detectAuthLibraries(dir: string): string[] {
  let deps: Record<string, unknown>;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return [];
  }
  return AUTH_PACKAGES.filter(([, packages]) => packages.some((name) => name in deps)).map(([label]) => label);
}

export interface ExtrasScope {
  selection: IntegrationSelection;
  authLibraries: string[];
}

/** One box saying what the pass will do, shown before asking to run it. */
export function showExtrasPlan(scope: ExtrasScope): void {
  const tools = [...scope.selection.integrations.map((i) => i.label), ...scope.selection.other];
  const rows = [
    row(
      'Identity',
      scope.authLibraries.length > 0
        ? `tie sessions to signed-in users (${scope.authLibraries.join(', ')})`
        : 'no auth library found; only added if there is a clear signed-in user',
    ),
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
