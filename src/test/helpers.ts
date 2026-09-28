import { vi } from 'vitest';
import type { WizardOptions } from '../config.js';

/**
 * Shared scaffolding for the suites. Almost every module in this codebase
 * either prompts the user (@clack/prompts), shells out, or talks to the
 * network, so the tests need a standard way to neutralize all three.
 */

/** A WizardOptions with the non-interactive defaults, overridable per test. */
export function makeOptions(overrides: Partial<WizardOptions> = {}): WizardOptions {
  return {
    dir: '/tmp/subtext-test-app',
    mock: false,
    telemetry: false,
    region: 'us',
    printPrompt: false,
    yes: true,
    debug: false,
    ...overrides,
  };
}

/**
 * A stand-in for @clack/prompts. Spinners and log calls become no-ops;
 * confirm/select/multiselect/text are spies a test queues answers onto:
 *
 *   const clack = clackStub();
 *   vi.mock('@clack/prompts', () => clack);
 *   clack.confirm.mockResolvedValueOnce(true);
 *
 * isCancel matches clack's real contract (the cancel symbol), so code paths
 * that branch on Ctrl+C can be driven with `clack.cancel$`.
 */
export function clackStub() {
  const cancel$ = Symbol.for('clack:cancel');
  return {
    cancel$,
    isCancel: (value: unknown) => value === cancel$,
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      message: vi.fn(),
    },
  };
}

/** A fetch stub that replays queued responses in order and records each call. */
export function fetchStub(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected fetch to ${String(input)}`);
    if (next instanceof Error) throw next;
    return next;
  });
  return { fn, calls };
}

/** JSON Response helper — `Response.json` isn't on the Node 20 floor. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
