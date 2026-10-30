import { apiBaseUrl } from './config.js';
import type { SubtextAuth } from './auth.js';

/**
 * The org's install checklist in Subtext (GET/POST /subtext/install/checklist)
 * and the first-session check (GET /subtext/install/first-event). The settings
 * page shows the checklist while the user installs, so the wizard and the agent
 * subcommands both report to it.
 *
 * Reporting is best-effort everywhere: a failed report must never fail an
 * install whose snippet is in.
 */

export const CHECKLIST_PATH = '/subtext/install/checklist';
export const FIRST_EVENT_PATH = '/subtext/install/first-event';

export type ChecklistStep = 'snippet' | 'csp' | 'identify' | 'integrations' | 'privacy' | 'plugin';
// Anything that only partly worked is a problem; the agent explains it in its summary.
export type ChecklistStatus = 'complete' | 'problem' | 'skipped';

export const CHECKLIST_STEPS: ChecklistStep[] = ['snippet', 'csp', 'identify', 'integrations', 'privacy', 'plugin'];
export const CHECKLIST_STATUSES: ChecklistStatus[] = ['complete', 'problem', 'skipped'];

export interface ApiClient {
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
}

/** An ApiClient for a fixed credential, as the wizard holds after login. */
export function authClient(auth: SubtextAuth): ApiClient {
  return {
    fetch: (pathname, init = {}) =>
      fetch(`${apiBaseUrl(auth.region)}${pathname}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `${auth.authScheme} ${auth.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      }),
  };
}

/** POST one step. Returns the HTTP status, or 0 if the request never landed. */
export async function reportStep(client: ApiClient, step: ChecklistStep, status: ChecklistStatus): Promise<number> {
  // The server rejects any field beyond these two.
  const body = {
    step: `INSTALL_STEP_${step.toUpperCase()}`,
    status: `INSTALL_STEP_STATUS_${status.toUpperCase()}`,
  };
  try {
    const res = await client.fetch(CHECKLIST_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.status;
  } catch {
    return 0;
  }
}

export interface ChecklistRow {
  step: ChecklistStep | 'verify';
  status: ChecklistStatus | 'not started';
}

export async function getChecklist(client: ApiClient): Promise<ChecklistRow[] | null> {
  try {
    const res = await client.fetch(CHECKLIST_PATH);
    if (!res.ok) return null;
    const body = (await res.json()) as { steps?: { step: string; status?: string }[] };
    return (body.steps ?? []).map((s) => {
      const status = (s.status ?? 'INSTALL_STEP_STATUS_UNSPECIFIED').replace('INSTALL_STEP_STATUS_', '').toLowerCase();
      return {
        step: s.step.replace('INSTALL_STEP_', '').toLowerCase() as ChecklistRow['step'],
        status: status === 'unspecified' ? 'not started' : (status as ChecklistStatus),
      };
    });
  } catch {
    return null;
  }
}

export type FirstEventOutcome = 'received' | 'timeout' | 'unauthorized';

/** Poll until the org's first session arrives, the deadline passes, or the credential is rejected. */
export async function waitForFirstEvent(
  client: ApiClient,
  timeoutMs: number,
  intervalMs = 5_000,
): Promise<FirstEventOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await client.fetch(FIRST_EVENT_PATH);
      if (res.status === 401 || res.status === 403) return 'unauthorized';
      if (res.ok && ((await res.json()) as { received?: boolean }).received) return 'received';
    } catch {
      // a dropped request shouldn't end the wait
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return 'timeout';
}
