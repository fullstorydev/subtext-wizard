import { describe, expect, it } from 'vitest';
import type { SubtextAuth } from './auth.js';
import { firstEventUrl, pollFirstEvent } from './firstEvent.js';
import { fetchStub, jsonResponse } from './test/helpers.js';

const auth: SubtextAuth = {
  accessToken: 'tok',
  authScheme: 'Bearer',
  orgId: 'o-1',
  region: 'us',
} as SubtextAuth;

const fast = { intervalMs: 1, timeoutMs: 1_000 };

describe('pollFirstEvent', () => {
  it('polls until received and sends the OAuth token', async () => {
    const { fn, calls } = fetchStub([
      jsonResponse({ received: false, first_event_time: null }),
      jsonResponse({ received: true, first_event_time: '2026-11-09T12:00:00Z' }),
    ]);
    const result = await pollFirstEvent(auth, { ...fast, fetchImpl: fn });
    expect(result).toEqual({ status: 'received', firstEventTime: '2026-11-09T12:00:00Z' });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(firstEventUrl(auth));
    expect(calls[0].url).toBe('https://api.fullstory.com/subtext/install/first-event');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('gives up immediately on an auth rejection', async () => {
    const { fn } = fetchStub([new Response('', { status: 403 })]);
    expect(await pollFirstEvent(auth, { ...fast, fetchImpl: fn })).toEqual({
      status: 'unavailable',
      reason: 'HTTP 403',
    });
  });

  it('rides out transient errors', async () => {
    const { fn } = fetchStub([
      new Error('ECONNRESET'),
      new Response('', { status: 502 }),
      jsonResponse({ received: true }),
    ]);
    expect((await pollFirstEvent(auth, { ...fast, fetchImpl: fn })).status).toBe('received');
  });

  it('reports unavailable after repeated errors', async () => {
    const { fn } = fetchStub(Array.from({ length: 5 }, () => new Error('offline')));
    expect(await pollFirstEvent(auth, { ...fast, fetchImpl: fn })).toEqual({
      status: 'unavailable',
      reason: 'offline',
    });
  });

  it('times out while still waiting', async () => {
    const { fn } = fetchStub(Array.from({ length: 50 }, () => jsonResponse({ received: false })));
    const result = await pollFirstEvent(auth, { intervalMs: 5, timeoutMs: 20, fetchImpl: fn });
    expect(result.status).toBe('timeout');
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const { fn } = fetchStub(Array.from({ length: 50 }, () => jsonResponse({ received: false })));
    const result = await pollFirstEvent(auth, {
      intervalMs: 10_000,
      fetchImpl: fn,
      signal: controller.signal,
      onTick: () => controller.abort(),
    });
    expect(result.status).toBe('aborted');
  });
});
