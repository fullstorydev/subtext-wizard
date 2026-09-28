import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clackStub, makeOptions } from './test/helpers.js';

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const { CancelledError, INTEGRATIONS, detectInstalledIntegrations, selectIntegrations } =
  await import('./integrations.js');

/**
 * The picker only steers the agent: whatever it misses, the agent's own
 * Step 2 explore still finds. So the load-bearing parts are the catalog's
 * own consistency and the --integrations parsing that CI runs depend on,
 * not exhaustive coverage of the prompts.
 */

const tmpDirs: string[] = [];

/** A throwaway project directory, optionally holding a package.json. */
function projectDir(pkg?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtext-integrations-'));
  tmpDirs.push(dir);
  if (pkg !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      typeof pkg === 'string' ? pkg : JSON.stringify(pkg),
    );
  }
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const ids = (result: { integrations: Array<{ id: string }> }) =>
  result.integrations.map((i) => i.id);

// ---------------------------------------------------------------------------

/**
 * The catalog is hand-maintained and feeds three places at once: the picker,
 * package detection, and the linkage examples pasted into the agent prompt.
 */
describe('the catalog', () => {
  it('has unique ids and labels', () => {
    expect(new Set(INTEGRATIONS.map((i) => i.id)).size).toBe(INTEGRATIONS.length);
    expect(new Set(INTEGRATIONS.map((i) => i.label)).size).toBe(INTEGRATIONS.length);
  });

  // selectIntegrations lowercases the --integrations values before matching,
  // so a capitalised id in the catalog would be unreachable from the flag.
  it.each(INTEGRATIONS.map((i) => [i.id] as const))('%s is a lowercase, spaceless id', (id) => {
    expect(id).toBe(id.toLowerCase());
    expect(id).not.toMatch(/\s/);
  });

  it.each(INTEGRATIONS.map((i) => [i.id, i] as const))(
    '%s is detectable by a package or a window global',
    (_id, integration) => {
      expect(integration.packages.length + (integration.globals?.length ?? 0)).toBeGreaterThan(0);
    },
  );

  it.each(INTEGRATIONS.map((i) => [i.id, i] as const))(
    '%s carries a linkage example naming the session URL',
    (_id, integration) => {
      expect(integration.linkageExample.trim()).not.toBe('');
      expect(integration.linkageExample).toMatch(/subtext_?[uU]rl/);
    },
  );

  it('never lists the same npm package under two tools', () => {
    const all = INTEGRATIONS.flatMap((i) => i.packages);
    expect(new Set(all).size).toBe(all.length);
  });
});

// ---------------------------------------------------------------------------

describe('detectInstalledIntegrations', () => {
  it('matches a runtime dependency', () => {
    const dir = projectDir({ dependencies: { 'posthog-js': '^1.0.0', react: '^18' } });
    expect(detectInstalledIntegrations(dir).map((i) => i.id)).toEqual(['posthog']);
  });

  it('matches a dev dependency too', () => {
    const dir = projectDir({ devDependencies: { '@sentry/react': '^8' } });
    expect(detectInstalledIntegrations(dir).map((i) => i.id)).toEqual(['sentry']);
  });

  it('matches any one of a tool’s aliases', () => {
    const dir = projectDir({ dependencies: { 'amplitude-js': '^8' } });
    expect(detectInstalledIntegrations(dir).map((i) => i.id)).toEqual(['amplitude']);
  });

  // Catalog order, not package.json order — the prompt and the picker both
  // read this list, so the ordering should not depend on how deps were typed.
  it('finds several tools at once, in catalog order', () => {
    const dir = projectDir({
      dependencies: { '@datadog/browser-rum': '^5', 'posthog-js': '^1' },
      devDependencies: { '@sentry/nextjs': '^8' },
    });
    expect(detectInstalledIntegrations(dir).map((i) => i.id)).toEqual([
      'posthog',
      'sentry',
      'datadog',
    ]);
  });

  // Detection is a convenience, never a source of truth — it must never be
  // the thing that fails a run.
  it('returns nothing when there is no package.json', () => {
    expect(detectInstalledIntegrations(projectDir())).toEqual([]);
  });

  it('returns nothing when package.json is unparseable', () => {
    expect(detectInstalledIntegrations(projectDir('{ not json'))).toEqual([]);
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(detectInstalledIntegrations('/nope/definitely/not/here')).toEqual([]);
  });

  it('returns nothing when there are no dependencies at all', () => {
    expect(detectInstalledIntegrations(projectDir({ name: 'app' }))).toEqual([]);
  });

  // Only npm packages are visible here; a script-tag install has no
  // dependency to match, which is why the agent detects again during Step 2.
  it('cannot see a script-tag install', () => {
    const dir = projectDir({ dependencies: {} });
    expect(detectInstalledIntegrations(dir)).toEqual([]);
    expect(INTEGRATIONS.find((i) => i.id === 'appcues')?.globals).toContain('Appcues');
  });
});

// ---------------------------------------------------------------------------

/** The non-interactive path: --integrations skips every prompt. */
describe('selectIntegrations with --integrations', () => {
  const withFlag = (values: string[]) =>
    selectIntegrations(makeOptions({ integrations: values, dir: projectDir() }));

  it('resolves known ids and asks nothing', async () => {
    const result = await withFlag(['posthog', 'sentry']);
    expect(ids(result)).toEqual(['posthog', 'sentry']);
    expect(result.other).toEqual([]);
    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('matches case-insensitively and trims whitespace', async () => {
    expect(ids(await withFlag([' PostHog ', 'MIXPANEL']))).toEqual(['posthog', 'mixpanel']);
  });

  it('keeps the order the user gave, not catalog order', async () => {
    expect(ids(await withFlag(['sentry', 'posthog']))).toEqual(['sentry', 'posthog']);
  });

  it('routes an unknown name to "other", preserving its original case', async () => {
    const result = await withFlag(['posthog', 'Heap']);
    expect(ids(result)).toEqual(['posthog']);
    expect(result.other).toEqual(['Heap']);
  });

  it('drops empty segments left by a trailing or doubled comma', async () => {
    const result = await withFlag(['posthog', '', '  ']);
    expect(ids(result)).toEqual(['posthog']);
    expect(result.other).toEqual([]);
  });

  it('returns an empty selection for an empty list rather than prompting', async () => {
    const result = await withFlag([]);
    expect(result).toEqual({ integrations: [], other: [] });
    expect(clack.multiselect).not.toHaveBeenCalled();
  });

  // Recorded, not endorsed: a repeated id lands twice and the prompt then
  // lists the tool twice. Harmless, but worth knowing it isn't deduped.
  it('does not dedupe a repeated id', async () => {
    expect(ids(await withFlag(['posthog', 'posthog']))).toEqual(['posthog', 'posthog']);
  });
});

// ---------------------------------------------------------------------------

describe('selectIntegrations interactively', () => {
  /** The options array handed to the multiselect. */
  const pickerOptions = () =>
    (clack.multiselect.mock.calls[0][0] as { options: Array<{ value: string; hint?: string }> })
      .options;

  const initialValues = () =>
    (clack.multiselect.mock.calls[0][0] as { initialValues?: string[] }).initialValues;

  describe('when nothing is detected', () => {
    const noDeps = () => makeOptions({ dir: projectDir({ dependencies: {} }) });

    it('goes straight to the picker with nothing pre-checked', async () => {
      clack.multiselect.mockResolvedValueOnce(['posthog']);

      const result = await selectIntegrations(noDeps());

      expect(clack.confirm).not.toHaveBeenCalled();
      expect(initialValues()).toBeUndefined();
      expect(ids(result)).toEqual(['posthog']);
    });

    it('offers every catalog tool plus an "Other" entry', async () => {
      clack.multiselect.mockResolvedValueOnce([]);
      await selectIntegrations(noDeps());

      const values = pickerOptions().map((o) => o.value);
      expect(values).toEqual([...INTEGRATIONS.map((i) => i.id), '__other__']);
    });

    it('accepts an empty selection', async () => {
      clack.multiselect.mockResolvedValueOnce([]);
      expect(await selectIntegrations(noDeps())).toEqual({ integrations: [], other: [] });
    });

    it('collects comma-separated free text behind "Other"', async () => {
      clack.multiselect.mockResolvedValueOnce(['sentry', '__other__']);
      clack.text.mockResolvedValueOnce(' Heap , FullStory Anywhere ,, ');

      const result = await selectIntegrations(noDeps());

      expect(ids(result)).toEqual(['sentry']);
      expect(result.other).toEqual(['Heap', 'FullStory Anywhere']);
    });

    it('treats an empty "Other" answer as naming nothing', async () => {
      clack.multiselect.mockResolvedValueOnce(['__other__']);
      clack.text.mockResolvedValueOnce('');
      expect(await selectIntegrations(noDeps())).toEqual({ integrations: [], other: [] });
    });

    it('returns results in catalog order regardless of pick order', async () => {
      clack.multiselect.mockResolvedValueOnce(['sentry', 'posthog']);
      expect(ids(await selectIntegrations(noDeps()))).toEqual(['posthog', 'sentry']);
    });
  });

  /**
   * Showing all fifteen options next to a single detected tool is noise, so a
   * detection collapses the catalog behind one "any others?" question.
   */
  describe('when something is detected', () => {
    const withPosthog = () =>
      makeOptions({ dir: projectDir({ dependencies: { 'posthog-js': '^1' } }) });

    it('confirms the detected set without opening the picker', async () => {
      clack.confirm.mockResolvedValueOnce(false);

      const result = await selectIntegrations(withPosthog());

      expect(ids(result)).toEqual(['posthog']);
      expect(clack.multiselect).not.toHaveBeenCalled();
      expect(clack.log.success).toHaveBeenCalled();
    });

    it('opens the picker with the detected tools pre-checked and hinted', async () => {
      clack.confirm.mockResolvedValueOnce(true);
      clack.multiselect.mockResolvedValueOnce(['posthog', 'sentry']);

      const result = await selectIntegrations(withPosthog());

      expect(initialValues()).toEqual(['posthog']);
      expect(pickerOptions().find((o) => o.value === 'posthog')?.hint).toBe('detected');
      expect(pickerOptions().find((o) => o.value === 'sentry')?.hint).toBeUndefined();
      expect(ids(result)).toEqual(['posthog', 'sentry']);
    });

    // A pre-check is a default, not a lock — the user has to be able to clear
    // a false positive.
    it('lets a detected tool be unchecked in the expanded picker', async () => {
      clack.confirm.mockResolvedValueOnce(true);
      clack.multiselect.mockResolvedValueOnce(['sentry']);

      expect(ids(await selectIntegrations(withPosthog()))).toEqual(['sentry']);
    });
  });

  describe('cancellation', () => {
    const noDeps = () => makeOptions({ dir: projectDir({ dependencies: {} }) });

    it('aborts the run when the picker is cancelled', async () => {
      clack.multiselect.mockResolvedValueOnce(clack.cancel$);
      await expect(selectIntegrations(noDeps())).rejects.toBeInstanceOf(CancelledError);
    });

    it('aborts the run when the "Other" text prompt is cancelled', async () => {
      clack.multiselect.mockResolvedValueOnce(['__other__']);
      clack.text.mockResolvedValueOnce(clack.cancel$);
      await expect(selectIntegrations(noDeps())).rejects.toBeInstanceOf(CancelledError);
    });

    it('aborts the run when the "any others?" confirm is cancelled', async () => {
      clack.confirm.mockResolvedValueOnce(clack.cancel$);
      const options = makeOptions({ dir: projectDir({ dependencies: { 'posthog-js': '^1' } }) });
      await expect(selectIntegrations(options)).rejects.toBeInstanceOf(CancelledError);
    });
  });
});
