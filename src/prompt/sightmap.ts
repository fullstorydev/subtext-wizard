import fs from 'node:fs';
import { packageRootPath } from '../paths.js';
import type { PromptMode } from './build.js';

export interface BuildSightmapPromptInput {
  mode: PromptMode;
  /** Dev-server URL for the live-coverage pass, or undefined to seed from code only. */
  appUrl?: string;
}

const HEADLESS_MODE_SECTION = `## Mode: autonomous (headless)

You are running non-interactively inside the Subtext setup CLI. The user cannot answer questions mid-run. Apply your best judgment, keep the corpus small and accurate rather than exhaustive, and record what you built (plus anything you'd have asked) in \`./sightmap-setup-report.md\`. Never block waiting for input.`;

const INTERACTIVE_MODE_SECTION = `## Mode: interactive

Work through the steps with the user in this conversation. Show them the components you intend to define before writing large batches, and let them steer which surfaces matter most.`;

/** The live-coverage pass only appears when the user gave us a dev-server URL. */
function liveSection(appUrl: string): string {
  return `## Step 4: Deepen coverage against the running app

A dev server is running at ${appUrl}. Use it to find components you couldn't see from the code alone.

1. Start a browser session: \`sightmap browser start --url '${appUrl}'\`.
2. For each meaningful route, take a coverage snapshot — \`sightmap snapshot --coverage --url '<route-url>'\` — and read which on-screen elements have no component mapped yet.
3. Add sightmap components for the uncovered elements that a person would name, using \`sightmap sel-probe\` to confirm a selector matches before you commit it.
4. Re-run \`sightmap validate\` and \`sightmap lint\` until clean.

If the \`sightmap-browser\` skill is available, use it to drive this loop.`;
}

export function buildSightmapPrompt(input: BuildSightmapPromptInput): string {
  const template = fs.readFileSync(packageRootPath('templates', 'sightmap-prompt.md'), 'utf8');
  const headless = input.mode === 'headless';
  const live = Boolean(input.appUrl);

  const replacements: Record<string, string> = {
    MODE_SECTION: headless ? HEADLESS_MODE_SECTION : INTERACTIVE_MODE_SECTION,
    LIVE_SECTION: live ? liveSection(input.appUrl!) : '',
    // The live pass is Step 4, so the report becomes Step 5 when it's present.
    REPORT_STEP: live ? '5' : '4',
    REPORT_VERB: headless ? 'Record' : 'Tell the user',
    REPORT_LOCATION: headless
      ? 'Put this in `./sightmap-setup-report.md`.'
      : '',
  };

  let prompt = template;
  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }
  return prompt.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
