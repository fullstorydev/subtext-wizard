import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WizardOptions } from './config.js';

/**
 * Everything the user types arrives here. The parts worth pinning are the
 * ones a wrong answer makes dangerous or confusing: which credential wins,
 * that --mock ignores the environment, and that a bad invocation exits
 * non-zero instead of starting an autonomous agent run.
 */

const runWizard = vi.hoisted(() => vi.fn<(options: WizardOptions) => Promise<number>>());
vi.mock('./run.js', () => ({ runWizard }));

const { main, resolveCredential } = await import('./cli.js');

// ---------------------------------------------------------------------------

/**
 * process.exit never returns. Modelling it as a throw is what stops main
 * from running on past a parse error, but a throw from inside main's own
 * .then/.catch would just become an unhandled rejection. So it throws only
 * while main is executing synchronously; async exits are recorded.
 */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

let out: string[];
let err: string[];
let exitCodes: number[];
let inSyncPhase = false;
let realVersions: PropertyDescriptor;

beforeEach(() => {
  out = [];
  err = [];
  // A real SUBTEXT_API_KEY in the developer's shell would otherwise change
  // what these tests see. Start from a known-empty credential environment.
  for (const name of ['SUBTEXT_API_KEY', 'SUBTEXT_API_KEY_OAUTH', 'DO_NOT_TRACK', 'DISABLE_TELEMETRY']) {
    vi.stubEnv(name, '');
  }
  // mockResolvedValue leaves the call history intact; options() reads
  // calls[0], so it has to be cleared or it reports an earlier test's run.
  runWizard.mockReset();
  runWizard.mockResolvedValue(0);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(' ')));
  exitCodes = [];
  inSyncPhase = false;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    if (inSyncPhase) throw new Exited(code ?? 0);
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  realVersions = Object.getOwnPropertyDescriptor(process, 'versions')!;
});

afterEach(() => {
  Object.defineProperty(process, 'versions', realVersions);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Invoke main with synchronous exits modelled as throws. */
function callMain(argv: string[]) {
  inSyncPhase = true;
  try {
    main(argv);
  } finally {
    inSyncPhase = false;
  }
}

/** Run main and report how the process would have ended. */
async function run(...argv: string[]): Promise<{ code: number }> {
  try {
    callMain(argv);
  } catch (error) {
    if (error instanceof Exited) return { code: error.code };
    throw error;
  }
  // --help and --version return without exiting at all; only the wizard
  // path has a pending exit to wait for.
  if (runWizard.mock.calls.length > 0) {
    await vi.waitFor(() => expect(exitCodes.length).toBeGreaterThan(0));
  }
  return { code: exitCodes[0] ?? 0 };
}

/** The options main built for the wizard. */
const options = (): WizardOptions => runWizard.mock.calls[0][0];

function setNodeVersion(version: string) {
  Object.defineProperty(process, 'versions', {
    value: { ...process.versions, node: version },
    configurable: true,
  });
}

// ---------------------------------------------------------------------------

describe('--help and --version', () => {
  it('prints help and never starts a wizard', async () => {
    await run('--help');

    expect(out.join('\n')).toContain('Usage:');
    expect(runWizard).not.toHaveBeenCalled();
  });

  it('prints the version alone', async () => {
    const { WIZARD_VERSION } = await import('./config.js');

    await run('--version');

    expect(out).toEqual([WIZARD_VERSION]);
    expect(runWizard).not.toHaveBeenCalled();
  });

  it('documents every flag it accepts', async () => {
    const { HELP } = await import('./cli.js');
    for (const flag of [
      '--dir',
      '--api-key',
      '--api-key-oauth',
      '--agent',
      '--integrations',
      '--print-prompt',
      '--yes',
      '--mock',
      '--no-telemetry',
      '--debug',
      '--version',
      '--help',
    ]) {
      expect(HELP).toContain(flag);
    }
  });
});

describe('bad invocations', () => {
  // Exiting non-zero matters more than the message: a typo must not fall
  // through into an autonomous agent run.
  it('exits 2 and prints help for an unknown flag', async () => {
    expect(await run('--nope')).toEqual({ code: 2 });

    expect(err.join('\n')).toContain('Usage:');
    expect(runWizard).not.toHaveBeenCalled();
  });

  it('exits 2 when both credential flags are given', async () => {
    expect(await run('--api-key', 'a', '--api-key-oauth', 'b')).toEqual({ code: 2 });

    expect(err.join('\n')).toContain('Pass only one of --api-key or --api-key-oauth');
    expect(runWizard).not.toHaveBeenCalled();
  });

  it('rejects positional arguments', async () => {
    expect(await run('some-dir')).toEqual({ code: 2 });
  });
});

describe('the Node floor', () => {
  it.each(['18.16.0', '17.9.1'])('refuses to run on %s', async (version) => {
    setNodeVersion(version);
    expect(await run('--mock')).toEqual({ code: 1 });
    expect(runWizard).not.toHaveBeenCalled();
  });

  it.each(['18.17.0', '18.20.4', '20.11.0', '24.0.0'])('accepts %s', async (version) => {
    setNodeVersion(version);
    await run('--mock');
    expect(runWizard).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

/**
 * Flags beat env vars so a credential need not appear in argv, where it
 * lands in shell history and the process list.
 */
describe('resolveCredential', () => {
  it('prefers --api-key-oauth and forces the OAuth path', () => {
    expect(resolveCredential({ 'api-key': 'plain', 'api-key-oauth': 'tok' }, false)).toEqual({
      apiKey: 'tok',
      apiKeyKind: 'oauth',
    });
  });

  it('auto-detects the kind for --api-key', () => {
    expect(resolveCredential({ 'api-key': 'plain' }, false)).toEqual({
      apiKey: 'plain',
      apiKeyKind: 'auto',
    });
  });

  it('falls back to the env vars, OAuth first', () => {
    vi.stubEnv('SUBTEXT_API_KEY', 'from-env');
    vi.stubEnv('SUBTEXT_API_KEY_OAUTH', 'oauth-from-env');

    expect(resolveCredential({}, false)).toEqual({
      apiKey: 'oauth-from-env',
      apiKeyKind: 'oauth',
    });
  });

  it('uses SUBTEXT_API_KEY when no OAuth var is set', () => {
    vi.stubEnv('SUBTEXT_API_KEY', 'from-env');
    expect(resolveCredential({}, false)).toEqual({ apiKey: 'from-env', apiKeyKind: 'auto' });
  });

  it('resolves to nothing when neither flag nor env is present', () => {
    expect(resolveCredential({}, false)).toEqual({ apiKeyKind: 'auto' });
  });

  /**
   * A SUBTEXT_API_KEY left in the shell would otherwise be validated — and
   * could be rejected — or short-circuit the canned mock auth, in a mode
   * whose whole point is making no network calls.
   */
  it('ignores the environment under --mock', () => {
    vi.stubEnv('SUBTEXT_API_KEY', 'from-env');
    vi.stubEnv('SUBTEXT_API_KEY_OAUTH', 'oauth-from-env');

    expect(resolveCredential({}, true)).toEqual({ apiKeyKind: 'auto' });
  });

  it('still honours an explicit flag under --mock', () => {
    vi.stubEnv('SUBTEXT_API_KEY', 'from-env');

    expect(resolveCredential({ 'api-key': 'explicit' }, true)).toEqual({
      apiKey: 'explicit',
      apiKeyKind: 'auto',
    });
  });
});

// ---------------------------------------------------------------------------

describe('the options it builds', () => {
  it('defaults to the current directory and the US region', async () => {
    await run();

    expect(options()).toMatchObject({
      dir: process.cwd(),
      region: 'us',
      mock: false,
      printPrompt: false,
      yes: false,
      debug: false,
      telemetry: true,
    });
  });

  it('resolves --dir to an absolute path', async () => {
    await run('--dir', 'sub/dir');
    expect(options().dir).toBe(`${process.cwd()}/sub/dir`);
  });

  it('leaves an already-absolute --dir alone', async () => {
    await run('--dir', '/work/app');
    expect(options().dir).toBe('/work/app');
  });

  it('splits --integrations, trimming and dropping blanks', async () => {
    await run('--integrations', ' posthog , sentry ,, ');
    expect(options().integrations).toEqual(['posthog', 'sentry']);
  });

  it('leaves integrations undefined when the flag is absent', async () => {
    await run();
    expect(options().integrations).toBeUndefined();
  });

  it('passes the boolean flags through', async () => {
    await run('--mock', '--yes', '--debug', '--print-prompt', '--agent', 'codex');

    expect(options()).toMatchObject({
      mock: true,
      yes: true,
      debug: true,
      printPrompt: true,
      agent: 'codex',
    });
  });

  describe('telemetry', () => {
    it('is on by default', async () => {
      await run();
      expect(options().telemetry).toBe(true);
    });

    it('is off with --no-telemetry', async () => {
      await run('--no-telemetry');
      expect(options().telemetry).toBe(false);
    });

    it.each(['DO_NOT_TRACK', 'DISABLE_TELEMETRY'])('is off with %s set', async (name) => {
      vi.stubEnv(name, '1');
      await run();
      expect(options().telemetry).toBe(false);
    });

    it('stays on when the opt-out var is set to a falsy value', async () => {
      vi.stubEnv('DO_NOT_TRACK', '0');
      await run();
      expect(options().telemetry).toBe(true);
    });
  });
});

describe('handing off to the wizard', () => {
  it('exits with whatever code the wizard returns', async () => {
    runWizard.mockResolvedValue(130);

    callMain([]);

    await vi.waitFor(() => expect(exitCodes).toEqual([130]));
  });

  it('exits 0 on a clean run', async () => {
    callMain([]);
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });

  it('exits 1 and prints the stack when the wizard throws', async () => {
    runWizard.mockRejectedValue(new Error('boom'));

    callMain([]);

    await vi.waitFor(() => expect(exitCodes).toEqual([1]));
    expect(err.join('\n')).toContain('boom');
  });

  it('warns about host overrides before anything else runs', async () => {
    const write = vi.mocked(process.stderr.write);
    vi.stubEnv('SUBTEXT_AUTH_BASE_URL', 'http://evil.test');

    await run('--help');

    expect(write.mock.calls.map(String).join('')).toContain('Ignoring SUBTEXT_AUTH_BASE_URL');
  });
});
