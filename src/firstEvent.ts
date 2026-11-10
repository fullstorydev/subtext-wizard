import type { SubtextAuth } from './auth.js';
import { WIZARD_VERSION, firstEventUrl as firstEventUrlFor } from './config.js';

/**
 * Polls lidar's `GET /subtext/install/first-event` until the org's first
 * captured session shows up. The route wraps the GetFirstEvent RPC and answers
 * `{ received: boolean, first_event_time?: string }`, authenticated with the
 * same OAuth token the wizard already holds for /mcp/subtext.
 */

export type FirstEventResult =
  | { status: 'received'; firstEventTime?: string }
  | { status: 'timeout' }
  | { status: 'aborted' }
  /** We can't check from here (auth rejected, route missing, network down).
   * Not a capture failure, so callers should fall back to "check the app". */
  | { status: 'unavailable'; reason: string };

export interface PollOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  /** Called after each poll that came back "still waiting". */
  onTick?: (elapsedMs: number) => void;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;
// A blip shouldn't end the wait, but a dead network shouldn't spin forever either.
const MAX_CONSECUTIVE_ERRORS = 5;

export function firstEventUrl(auth: SubtextAuth): string {
  return firstEventUrlFor(auth.region);
}

export async function pollFirstEvent(
  auth: SubtextAuth,
  opts: PollOptions = {},
): Promise<FirstEventResult> {
  const {
    signal,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    onTick,
    fetchImpl = fetch,
  } = opts;
  const url = firstEventUrl(auth);
  const started = Date.now();
  let errors = 0;
  let lastError = '';

  while (!signal?.aborted) {
    // AbortSignal.any is Node 20.3+, and we support 18.17.
    const attempt = new AbortController();
    const onAbort = () => attempt.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const attemptTimer = setTimeout(() => attempt.abort(), 10_000);
    try {
      const res = await fetchImpl(url, {
        headers: {
          Authorization: `${auth.authScheme} ${auth.accessToken}`,
          Accept: 'application/json',
          'User-Agent': `subtext-wizard/${WIZARD_VERSION}`,
        },
        signal: attempt.signal,
      });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        return { status: 'unavailable', reason: `HTTP ${res.status}` };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { received?: boolean; first_event_time?: string | null };
      errors = 0;
      if (body.received) {
        return { status: 'received', firstEventTime: body.first_event_time ?? undefined };
      }
    } catch (error) {
      if (signal?.aborted) break;
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
      if (errors >= MAX_CONSECUTIVE_ERRORS) return { status: 'unavailable', reason: lastError };
    } finally {
      clearTimeout(attemptTimer);
      signal?.removeEventListener('abort', onAbort);
    }

    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) return { status: 'timeout' };
    onTick?.(elapsed);
    if (!(await sleep(intervalMs, signal))) break;
  }
  return { status: 'aborted' };
}

/** Resolves false if aborted mid-sleep. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
