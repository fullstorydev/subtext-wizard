import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIZARD_VERSION } from './config.js';
import { Telemetry, type WorkflowEventMetadata } from './telemetry.js';

/**
 * The funnel's delivery layer. Two properties matter more than the payload
 * shape: it must never throw into the wizard (a failed event can't break an
 * install), and it must never deliver anything before authorize() — the
 * endpoint rejects unauthenticated posts, so an event sent early is lost
 * rather than queued.
 */

const ENDPOINT = 'https://api.fullstory.com/subtext/telemetry';

/** Captures the fetch calls and lets a test decide how each one settles. */
function stubFetch(settle: () => Promise<Response> = () => Promise.resolve(new Response(''))) {
  const fn = vi.fn((_url: string | URL | Request, _init?: RequestInit) => settle());
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** The parsed body of the nth POST. */
function payload(fetchFn: ReturnType<typeof stubFetch>, n = 0) {
  return JSON.parse(String(fetchFn.mock.calls[n][1]?.body)) as Record<string, unknown>;
}

function authorized(debug = false) {
  const telemetry = new Telemetry(true, debug);
  telemetry.authorize(ENDPOINT, 'tok-123');
  return telemetry;
}

/** Debug output goes to console.error; collect it rather than let it print. */
let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const debugOutput = () => logged.join('\n');

describe('when disabled', () => {
  it('sends nothing and prints nothing, even under --debug', () => {
    const fetchFn = stubFetch();
    const telemetry = new Telemetry(false, true);
    telemetry.authorize(ENDPOINT, 'tok-123');

    telemetry.step('start');
    telemetry.step('complete', 'success');
    telemetry.finish('fail');

    expect(fetchFn).not.toHaveBeenCalled();
    expect(debugOutput()).toBe('');
  });

  it('resolves flush immediately', async () => {
    await expect(new Telemetry(false, false).flush()).resolves.toBeUndefined();
  });
});

describe('before authorize', () => {
  it('drops the event but still shows it under --debug', () => {
    const fetchFn = stubFetch();
    const telemetry = new Telemetry(true, true);

    telemetry.step('precheck', 'success');

    expect(fetchFn).not.toHaveBeenCalled();
    expect(debugOutput()).toContain('[telemetry] {"workflow":"onboard","step":"precheck"');
  });

  it('stays quiet without --debug', () => {
    new Telemetry(true, false).step('precheck', 'success');
    expect(debugOutput()).toBe('');
  });
});

describe('payload shape', () => {
  it('always names the onboard workflow', () => {
    const fetchFn = stubFetch();
    authorized().step('explore', 'success');
    expect(payload(fetchFn).workflow).toBe('onboard');
  });

  it('omits outcome when none is given', () => {
    const fetchFn = stubFetch();
    authorized().step('explore');
    expect(payload(fetchFn)).not.toHaveProperty('outcome');
  });

  it('omits metadata entirely when it would be empty', () => {
    const fetchFn = stubFetch();
    authorized().step('explore', 'success');
    expect(payload(fetchFn)).toEqual({ workflow: 'onboard', step: 'explore', outcome: 'success' });
  });

  it('passes metadata through for a non-bookend step', () => {
    const fetchFn = stubFetch();
    const metadata: WorkflowEventMetadata = { framework: 'next', csp_modified: true };
    authorized().step('install', 'success', metadata);
    expect(payload(fetchFn).metadata).toEqual(metadata);
  });
});

describe('request', () => {
  it('POSTs JSON to the authorized endpoint', () => {
    const fetchFn = stubFetch();
    authorized().step('install', 'success');

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('carries the wizard version in the User-Agent', () => {
    const fetchFn = stubFetch();
    authorized().step('install');
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({
      'User-Agent': `subtext-wizard/${WIZARD_VERSION}`,
    });
  });

  it('defaults the auth scheme to Bearer for an OAuth token', () => {
    const fetchFn = stubFetch();
    authorized().step('install');
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer tok-123',
    });
  });

  // A normal Fullstory API key goes as Basic — the scheme is resolved at login
  // and carried here, never hardcoded.
  it('honors a Basic scheme for an API key', () => {
    const fetchFn = stubFetch();
    const telemetry = new Telemetry(true, false);
    telemetry.authorize(ENDPOINT, 'api-key', 'Basic');
    telemetry.step('install');

    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Basic api-key',
    });
  });

  it('attaches an abort signal so a hung endpoint cannot stall the wizard', () => {
    const fetchFn = stubFetch();
    authorized().step('install');
    expect(fetchFn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('duration stamping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('stamps duration_ms on start', () => {
    const fetchFn = stubFetch();
    const telemetry = authorized();
    vi.advanceTimersByTime(1_500);

    telemetry.step('start');

    expect(payload(fetchFn).metadata).toEqual({ duration_ms: 1_500 });
  });

  it('stamps total_duration_ms on complete', () => {
    const fetchFn = stubFetch();
    const telemetry = authorized();
    vi.advanceTimersByTime(42_000);

    telemetry.step('complete', 'success');

    expect(payload(fetchFn).metadata).toEqual({ total_duration_ms: 42_000 });
  });

  // The default is a fallback, not an override: an agent-reported duration for
  // the same event has to win.
  it('lets explicit metadata override the stamped default', () => {
    const fetchFn = stubFetch();
    const telemetry = authorized();
    vi.advanceTimersByTime(1_500);

    telemetry.step('start', undefined, { duration_ms: 7 });

    expect(payload(fetchFn).metadata).toMatchObject({ duration_ms: 7 });
  });

  it('merges the stamp alongside other metadata', () => {
    const fetchFn = stubFetch();
    const telemetry = authorized();
    vi.advanceTimersByTime(900);

    telemetry.step('complete', 'success', { harness: 'claude-code' });

    expect(payload(fetchFn).metadata).toEqual({
      total_duration_ms: 900,
      harness: 'claude-code',
    });
  });

  it('does not stamp a duration on an intermediate step', () => {
    const fetchFn = stubFetch();
    const telemetry = authorized();
    vi.advanceTimersByTime(900);

    telemetry.step('plan', 'success');

    expect(payload(fetchFn)).not.toHaveProperty('metadata');
  });
});

/**
 * finish() is how a run that died early still closes its funnel entry. Before
 * the handoff there is no start to complete, so the outcome rides on the start
 * event itself; after the handoff it lands as a complete.
 */
describe('finish', () => {
  it('reports on the start event when no start has been sent', () => {
    const fetchFn = stubFetch();
    authorized().finish('skipped');

    expect(payload(fetchFn)).toMatchObject({ step: 'start', outcome: 'skipped' });
  });

  it('reports on a complete event once a start has gone out', () => {
    const fetchFn = stubFetch();
    const telemetry = authorized();

    telemetry.step('start');
    telemetry.finish('fail', { harness: 'codex' });

    expect(payload(fetchFn, 1)).toMatchObject({ step: 'complete', outcome: 'fail' });
    expect(payload(fetchFn, 1).metadata).toMatchObject({ harness: 'codex' });
  });

  // startSent is set inside step(), which returns early when disabled — so a
  // disabled instance must not emit anything from finish() either.
  it('stays silent when telemetry is disabled', () => {
    const fetchFn = stubFetch();
    const telemetry = new Telemetry(false, false);
    telemetry.authorize(ENDPOINT, 'tok-123');

    telemetry.step('start');
    telemetry.finish('success');

    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('note', () => {
  it('prints a breadcrumb under --debug', () => {
    authorized(true).note('agents_detected', { agents: ['claude-code'] });
    expect(debugOutput()).toContain('[telemetry:note] agents_detected {"agents":["claude-code"]}');
  });

  it('never reaches the network — the endpoint has no field for these', () => {
    const fetchFn = stubFetch();
    authorized(true).note('wizard_started');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('prints nothing without --debug', () => {
    authorized(false).note('wizard_started');
    expect(debugOutput()).toBe('');
  });

  // Unlike step(), note() is gated on --debug alone, not on telemetry being
  // enabled. That's fine — it never leaves the user's own terminal — but it's
  // the one asymmetry in the class, so pin it rather than leave it to chance.
  it('still prints under --debug when telemetry is opted out', () => {
    new Telemetry(false, true).note('wizard_started');
    expect(debugOutput()).toContain('[telemetry:note] wizard_started');
  });
});

describe('failure isolation', () => {
  it('swallows a rejected request rather than throwing into the wizard', async () => {
    const telemetry = authorized();
    stubFetch(() => Promise.reject(new Error('ENOTFOUND')));

    expect(() => telemetry.step('install', 'success')).not.toThrow();
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });

  it('keeps sending after an earlier event failed', async () => {
    let call = 0;
    const fetchFn = stubFetch(() =>
      ++call === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(new Response('')),
    );
    const telemetry = authorized();

    telemetry.step('install', 'fail');
    telemetry.step('complete', 'success');

    await telemetry.flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('flush', () => {
  it('waits for in-flight requests to settle', async () => {
    let release!: (value: Response) => void;
    stubFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const telemetry = authorized();
    telemetry.step('complete', 'success');

    let settled = false;
    const flushed = telemetry.flush().then(() => (settled = true));

    await Promise.resolve();
    expect(settled).toBe(false);

    release(new Response(''));
    await flushed;
    expect(settled).toBe(true);
  });

  // Exit must not hang on a telemetry endpoint that never answers.
  it('gives up at the deadline when a request never settles', async () => {
    vi.useFakeTimers();
    stubFetch(() => new Promise<Response>(() => {}));
    const telemetry = authorized();
    telemetry.step('complete', 'success');

    const flushed = telemetry.flush(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(flushed).resolves.toBeUndefined();
  });

  it('returns immediately when nothing was ever sent', async () => {
    stubFetch();
    await expect(authorized().flush()).resolves.toBeUndefined();
  });
});
