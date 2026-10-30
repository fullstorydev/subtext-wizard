import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import open from 'open';
import { decodeTokenClaims } from './auth.js';
import {
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
  apiBaseUrl,
  authBaseUrl,
  subtextOauthResource,
  type Region,
  type WizardOptions,
} from './config.js';
import {
  CHECKLIST_INTEGRATIONS,
  CHECKLIST_STATUSES,
  CHECKLIST_STEPS,
  getChecklist,
  reportStep,
  waitForFirstEvent,
  type ApiClient,
  type ChecklistStatus,
  type ChecklistStep,
} from './checklist.js';
import { fetchCaptureSnippet } from './snippet.js';

/**
 * Small subcommands for a coding agent following the install instructions on
 * the site. The point is that the agent never sees or handles the token: auth
 * stores it here, and every later command reads it back. Tokens passed around
 * in shell commands are exactly what auto-mode permission checks block.
 *
 *   auth                 device-flow sign-in; prints the link, waits, prints the org id
 *   snippet              prints the org's capture snippet
 *   report <step> <status> [--integration <name> ...]
 *   wait-first-event     waits until the org's first session arrives
 *   checklist            prints the checklist
 */

const DEVICE_AUTHORIZATION_PATH = '/oauth/device_authorization';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface Session {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  orgId: string;
  region: Region;
  authBase: string;
  apiBase: string;
}

// One file per user, mode 0600. Keyed by auth host so dev and production
// sessions don't overwrite each other.
function sessionPath(authBase: string): string {
  const dir = path.join(os.homedir(), '.config', 'subtext');
  return path.join(dir, `session-${new URL(authBase).host.replace(/[^a-z0-9.-]/gi, '_')}.json`);
}

function saveSession(s: Session): void {
  const file = sessionPath(s.authBase);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
}

function loadSession(region: Region): Session {
  const file = sessionPath(authBaseUrl(region));
  if (!fs.existsSync(file)) {
    throw new UsageError('Not signed in. Run the `auth` subcommand first.');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Session;
}

class UsageError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postForm(url: string, body: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function registerDeviceClient(authBase: string): Promise<string> {
  const res = await fetch(`${authBase}${OAUTH_REGISTER_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Subtext Install (agent)',
      grant_types: [DEVICE_GRANT, 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Client registration failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function runAuth(options: WizardOptions, flags: { noOpen: boolean }): Promise<number> {
  const authBase = authBaseUrl(options.region);
  const clientId = await registerDeviceClient(authBase);
  const start = await postForm(`${authBase}${DEVICE_AUTHORIZATION_PATH}`, {
    client_id: clientId,
    resource: subtextOauthResource(options.region),
  });
  if (start.status !== 200) throw new Error(`Device authorization failed (${start.status}): ${JSON.stringify(start.json)}`);
  const { device_code, user_code, verification_uri_complete, expires_in, interval } = start.json;

  console.log(`Open this link to sign in or sign up, then approve:\n  ${verification_uri_complete}`);
  console.log(`The page should show the code ${user_code}. Waiting for approval...`);
  if (!flags.noOpen) await open(verification_uri_complete).catch(() => {});

  let wait = (interval ?? 5) * 1000;
  const deadline = Date.now() + (expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(wait);
    const r = await postForm(`${authBase}${OAUTH_TOKEN_PATH}`, {
      grant_type: DEVICE_GRANT,
      device_code,
      client_id: clientId,
    });
    if (r.status === 200 && r.json.access_token) {
      const claims = decodeTokenClaims(r.json.access_token);
      if (!claims?.orgId) throw new Error('Signed in, but the token has no org id.');
      const region = claims.region ?? options.region;
      saveSession({
        clientId,
        accessToken: r.json.access_token,
        refreshToken: r.json.refresh_token,
        orgId: claims.orgId,
        region,
        authBase,
        apiBase: apiBaseUrl(region),
      });
      console.log(`Signed in${claims.userEmail ? ` as ${claims.userEmail}` : ''}.`);
      console.log(`org_id: ${claims.orgId}`);
      return 0;
    }
    const err = r.json.error;
    if (r.status === 429 || err === 'slow_down') wait += 5000;
    else if (err === 'access_denied') { console.log('The user declined the sign-in.'); return 1; }
    else if (err === 'expired_token') break;
    else if (err !== 'authorization_pending') throw new Error(`Token request failed (${r.status}): ${err ?? ''}`);
  }
  console.log('The sign-in link expired before it was approved. Run `auth` again.');
  return 1;
}

// Retries once after a refresh on 401, so a long install doesn't die at the
// token's expiry.
function sessionClient(s: Session): ApiClient {
  return {
    async fetch(pathname, init = {}) {
      const go = () =>
        fetch(`${s.apiBase}${pathname}`, {
          ...init,
          headers: { ...(init.headers ?? {}), Authorization: `Bearer ${s.accessToken}` },
          signal: AbortSignal.timeout(15_000),
        });
      let res = await go();
      if (res.status === 401 && s.refreshToken) {
        const r = await postForm(`${s.authBase}${OAUTH_TOKEN_PATH}`, {
          grant_type: 'refresh_token',
          refresh_token: s.refreshToken,
          client_id: s.clientId,
        });
        if (r.status === 200 && r.json.access_token) {
          s.accessToken = r.json.access_token;
          if (r.json.refresh_token) s.refreshToken = r.json.refresh_token;
          saveSession(s);
          res = await go();
        }
      }
      return res;
    },
  };
}

async function runReport(options: WizardOptions, args: string[], integrations: string[]): Promise<number> {
  const [step, status] = args;
  if (!CHECKLIST_STEPS.includes(step as ChecklistStep)) {
    throw new UsageError(`Unknown step "${step ?? ''}". Use one of: ${CHECKLIST_STEPS.join(', ')}`);
  }
  if (!CHECKLIST_STATUSES.includes(status as ChecklistStatus)) {
    throw new UsageError(`Unknown status "${status ?? ''}". Use one of: ${CHECKLIST_STATUSES.join(', ')}`);
  }
  if (integrations.length > 0 && step !== 'integrations') {
    throw new UsageError('--integration only applies to the integrations step.');
  }
  const names = integrations.map((i) => i.trim().toLowerCase());
  const unknown = names.filter((n) => !CHECKLIST_INTEGRATIONS.includes(n));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown integration "${unknown[0]}". Use one of: ${CHECKLIST_INTEGRATIONS.join(', ')}. Leave out tools not on this list.`,
    );
  }
  const code = await reportStep(sessionClient(loadSession(options.region)), step as ChecklistStep, status as ChecklistStatus, names);
  if (code < 200 || code >= 300) {
    console.log(`Report not saved (${code || 'no response'}). Carry on with the install.`);
    return 1;
  }
  console.log(`Reported ${step}: ${status}.`);
  return 0;
}

async function runWaitFirstEvent(options: WizardOptions, timeoutSec: number): Promise<number> {
  const outcome = await waitForFirstEvent(sessionClient(loadSession(options.region)), timeoutSec * 1000);
  if (outcome === 'received') { console.log('First session received.'); return 0; }
  if (outcome === 'unauthorized') {
    console.log("Can't check for sessions. Ask the user to confirm in the browser.");
    return 1;
  }
  console.log(`No session yet after ${timeoutSec}s.`);
  return 1;
}

async function runChecklist(options: WizardOptions): Promise<number> {
  const rows = await getChecklist(sessionClient(loadSession(options.region)));
  if (!rows) { console.log("Couldn't read the checklist."); return 1; }
  for (const r of rows) console.log(`${r.step}: ${r.status}`);
  return 0;
}

async function runSnippet(options: WizardOptions, orgFlag?: string): Promise<number> {
  let orgId = orgFlag;
  let region = options.region;
  if (!orgId) {
    const s = loadSession(options.region);
    orgId = s.orgId;
    region = s.region;
  }
  const snippet = await fetchCaptureSnippet(
    { accessToken: '', authScheme: 'Bearer', orgId, region },
    options,
  );
  console.log(snippet);
  return 0;
}

export const AGENT_SUBCOMMANDS = ['auth', 'snippet', 'report', 'wait-first-event', 'checklist'];

export async function runAgentSubcommand(
  command: string,
  args: string[],
  flags: { integration: string[]; org?: string; timeout?: string; noOpen: boolean },
  options: WizardOptions,
): Promise<number> {
  try {
    switch (command) {
      case 'auth':
        return await runAuth(options, flags);
      case 'snippet':
        return await runSnippet(options, flags.org);
      case 'report':
        return await runReport(options, args, flags.integration);
      case 'wait-first-event':
        return await runWaitFirstEvent(options, Number(flags.timeout ?? 300));
      case 'checklist':
        return await runChecklist(options);
    }
    throw new UsageError(`Unknown command ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  }
}
