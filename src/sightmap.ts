import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runTerminalAgent, which } from './agents/helpers.js';
import { MANUAL_CHOICE } from './agents/index.js';
import type { DetectedAgent } from './agents/types.js';
import type { WizardOptions } from './config.js';
import { buildSightmapPrompt } from './prompt/sightmap.js';

/**
 * Post-install: offer to build a `.sightmap/` component corpus so future
 * Subtext session reviews come back annotated with semantic component names
 * instead of raw CSS selectors. Independent of the capture snippet — the
 * corpus maps the app's UI regardless of capture — but it only pays off in
 * review, so onboarding is the natural place to front-load it.
 *
 * Delivery follows the sightmap quickstart: the standalone `@sightmap/sightmap`
 * CLI provides the binary that both the wizard and the agent's authoring skill
 * shell out to (`validate`, `lint`, `snapshot`, `browser start`), so it must be
 * on PATH before any authoring happens. The corpus itself is authored by the
 * user's own coding agent — same handoff model as the main install — because
 * the CLI has no "seed" command; writing the YAML is an agent task guided by
 * the `sightmap-authoring` skill (or the docs, as a fallback).
 *
 * Never throws: the install already succeeded, so sightmap trouble is reported
 * and the wizard still finishes cleanly.
 */

const SIGHTMAP_PACKAGE = '@sightmap/sightmap';
const SIGHTMAP_DOCS = 'https://docs.sightmap.org/start/quickstart';

const WHY_SIGHTMAP =
  'A sightmap maps your UI components so Subtext session reviews name them ("add-to-cart button") instead of showing raw selectors.';

type OnEvent = (event: string, properties?: Record<string, unknown>) => void;

/** True when we can drive the authoring run ourselves in this terminal. */
function isAutoDrivable(
  chosen: DetectedAgent | typeof MANUAL_CHOICE,
): chosen is DetectedAgent {
  return (
    chosen !== MANUAL_CHOICE &&
    chosen.definition.kind === 'terminal' &&
    Boolean(chosen.binaryPath)
  );
}

/** The two commands, shown in instructions and mock output. */
function provisionCommands(): string[] {
  return [`npm install -g ${SIGHTMAP_PACKAGE}`, 'sightmap skills install'];
}

/**
 * Put the sightmap CLI (and its authoring skill) on PATH, per the quickstart.
 * A global install is deliberate: the agent's later skill calls invoke a bare
 * `sightmap`, so the binary has to be resolvable outside this process — an
 * npx-only approach wouldn't survive the handoff. Returns whether `sightmap`
 * ended up runnable; failures fall back to instructions, never abort.
 */
async function provisionCli(cwd: string): Promise<boolean> {
  const existing = await which('sightmap');
  if (existing) {
    p.log.info(pc.dim('sightmap CLI already installed — skipping install.'));
  } else {
    const npm = await which('npm');
    if (!npm) {
      p.log.warn('Could not find npm on PATH to install the sightmap CLI.');
      return false;
    }
    p.log.step(`Installing the sightmap CLI (${SIGHTMAP_PACKAGE})…`);
    let installExit: number;
    try {
      installExit = await runTerminalAgent({
        binaryPath: npm,
        args: ['install', '-g', SIGHTMAP_PACKAGE],
        cwd,
        stdout: 'inherit',
      });
    } catch {
      installExit = 1;
    }
    if (installExit !== 0 || !(await which('sightmap'))) {
      p.log.warn(
        'sightmap CLI install failed — you may need elevated permissions ' +
          `(e.g. sudo npm install -g ${SIGHTMAP_PACKAGE}).`,
      );
      return false;
    }
  }

  // Skills are best-effort: the authoring prompt falls back to the docs when
  // the skill isn't present, so a failed `skills install` doesn't sink setup.
  const sightmap = await which('sightmap');
  if (sightmap) {
    try {
      await runTerminalAgent({
        binaryPath: sightmap,
        args: ['skills', 'install'],
        cwd,
        stdout: 'inherit',
      });
    } catch {
      p.log.info(pc.dim('sightmap skills install skipped — the agent will use the docs instead.'));
    }
  }
  return true;
}

/** Interactive-only: an optional dev-server URL enables the live-coverage pass. */
async function askAppUrl(options: WizardOptions): Promise<string | undefined> {
  if (options.yes) return undefined; // CI: never prompt; static seed only.
  const answer = await p.text({
    message:
      'Local dev server running? Paste its URL to deepen coverage against the live app (blank = seed from code only):',
    placeholder: 'http://localhost:3000',
  });
  if (p.isCancel(answer)) return undefined;
  const url = String(answer ?? '').trim();
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) {
    p.log.warn('That does not look like an http(s) URL — seeding from code only.');
    return undefined;
  }
  return url;
}

/** Manual / GUI-app path: we can't drive a second run, so hand over the recipe. */
function showInstructions(onEvent: OnEvent): void {
  p.note(
    [
      WHY_SIGHTMAP,
      '',
      'Install the CLI and its authoring skill:',
      ...provisionCommands().map((c) => `  ${c}`),
      '',
      'Then, in your coding agent at this project, ask it to:',
      '  "Use the sightmap-authoring skill to seed a .sightmap/ corpus from',
      '   this codebase, then run sightmap validate and sightmap lint."',
      '',
      `Reference: ${SIGHTMAP_DOCS}`,
    ].join('\n'),
    'Add semantic component names',
  );
  onEvent('sightmap_instructions_shown');
}

export async function offerSightmapSetup(
  chosen: DetectedAgent | typeof MANUAL_CHOICE,
  options: WizardOptions,
  onEvent: OnEvent,
): Promise<void> {
  // In CI (--yes) sightmap is off unless explicitly asked for: it installs a
  // global and, for the live pass, wants a running app — not something to
  // spring on an unattended run.
  if (options.yes && !options.sightmap) return;

  onEvent('sightmap_offered', {
    agent: chosen === MANUAL_CHOICE ? MANUAL_CHOICE : chosen.definition.id,
  });

  // Confirm gate, matching the wizard's other post-install offers. --yes with
  // --sightmap is the standing authorization; otherwise ask.
  if (!options.yes) {
    const yes = await p.confirm({
      message: `Build a component sightmap so reviews name your UI? ${pc.dim(
        `(installs ${SIGHTMAP_PACKAGE})`,
      )}`,
    });
    if (p.isCancel(yes) || !yes) {
      onEvent('sightmap_declined');
      return;
    }
  }

  if (!isAutoDrivable(chosen)) {
    // Manual prompt, or a GUI app we can't relaunch headlessly — hand over the
    // commands and the one-line ask instead of driving it.
    showInstructions(onEvent);
    return;
  }

  // Gather the live-pass URL before building the prompt so the corpus is
  // authored in a single agent run rather than two.
  const appUrl = await askAppUrl(options);

  if (options.mock) {
    p.log.info(
      pc.dim(
        `Mock mode: would run\n  ${provisionCommands().join('\n  ')}\n` +
          `then hand ${chosen.definition.name} a sightmap authoring prompt` +
          (appUrl ? ` (with a live pass against ${appUrl}).` : '.'),
      ),
    );
    onEvent('sightmap_authored', { method: 'mock', live: Boolean(appUrl) });
    return;
  }

  const provisioned = await provisionCli(options.dir);
  onEvent('sightmap_provisioned', { ok: provisioned });
  if (!provisioned) {
    showInstructions(onEvent);
    return;
  }

  const prompt = buildSightmapPrompt({ mode: 'headless', appUrl });
  p.log.step(`Authoring the sightmap with ${chosen.definition.name}…`);
  let result;
  try {
    result = await chosen.definition.launch({
      prompt,
      cwd: options.dir,
      binaryPath: chosen.binaryPath,
      debug: options.debug,
      onEvent,
    });
  } catch (error) {
    p.log.warn(
      `Sightmap authoring didn't run: ${error instanceof Error ? error.message : String(error)}`,
    );
    onEvent('sightmap_authored', { method: 'launch', outcome: 'error', live: Boolean(appUrl) });
    return;
  }

  const ok = result.mode === 'ran' && result.exitCode === 0;
  onEvent('sightmap_authored', {
    method: 'launch',
    outcome: ok ? 'success' : 'partial',
    exit_code: result.exitCode ?? null,
    live: Boolean(appUrl),
  });
  if (ok) {
    p.log.success('Sightmap corpus authored in .sightmap/ — reviews will use it once uploaded.');
  } else {
    p.log.warn(
      'Sightmap authoring finished without a clean exit — check .sightmap/ and sightmap-setup-report.md.',
    );
  }
}
