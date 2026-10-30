import { describe, expect, it } from 'vitest';
import { getChecklist, reportStep, waitForFirstEvent, type ApiClient } from './checklist.js';

function fakeClient(respond: (pathname: string, init?: RequestInit) => Response): ApiClient & { calls: { pathname: string; body?: unknown }[] } {
  const calls: { pathname: string; body?: unknown }[] = [];
  return {
    calls,
    async fetch(pathname, init) {
      calls.push({ pathname, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return respond(pathname, init);
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('reportStep', () => {
  it('sends the server enum names', async () => {
    const client = fakeClient(() => json({}));
    expect(await reportStep(client, 'snippet', 'complete')).toBe(200);
    expect(client.calls[0].body).toEqual({ step: 'INSTALL_STEP_SNIPPET', status: 'INSTALL_STEP_STATUS_COMPLETE' });
  });

  it('sends only step and status', async () => {
    const client = fakeClient(() => json({}));
    await reportStep(client, 'integrations', 'problem');
    expect(client.calls[0].body).toEqual({ step: 'INSTALL_STEP_INTEGRATIONS', status: 'INSTALL_STEP_STATUS_PROBLEM' });
  });

  it('returns 0 instead of throwing when the request fails', async () => {
    const client: ApiClient = { fetch: async () => { throw new Error('offline'); } };
    expect(await reportStep(client, 'csp', 'skipped')).toBe(0);
  });
});

describe('getChecklist', () => {
  it('maps enum names to short ones, with unset as not started', async () => {
    const client = fakeClient(() =>
      json({
        steps: [
          { step: 'INSTALL_STEP_SNIPPET', status: 'INSTALL_STEP_STATUS_COMPLETE' },
          { step: 'INSTALL_STEP_VERIFY' },
        ],
      }),
    );
    expect(await getChecklist(client)).toEqual([
      { step: 'snippet', status: 'complete' },
      { step: 'verify', status: 'not started' },
    ]);
  });
});

describe('waitForFirstEvent', () => {
  it('returns once a session is received', async () => {
    let n = 0;
    const client = fakeClient(() => json({ received: ++n >= 2 }));
    expect(await waitForFirstEvent(client, 1_000, 1)).toBe('received');
  });

  it('stops on a rejected credential', async () => {
    const client = fakeClient(() => json({}, 401));
    expect(await waitForFirstEvent(client, 1_000, 1)).toBe('unauthorized');
  });

  it('times out', async () => {
    const client = fakeClient(() => json({ received: false }));
    expect(await waitForFirstEvent(client, 20, 5)).toBe('timeout');
  });
});
