import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as p from '@clack/prompts';
import open from 'open';
import pc from 'picocolors';
import {
  AUTH_CALLBACK_TIMEOUT_MS,
  AUTH_PROMPT_AFTER_MS,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_SCOPES,
  OAUTH_TOKEN_PATH,
  authBaseUrl,
  oauthClientId,
  subtextOauthResource,
  type Region,
  type WizardOptions,
} from './config.js';

export interface SubtextAuth {
  accessToken: string;
  refreshToken?: string;
  orgId: string;
  userEmail?: string;
  /** Data realm the org lives in, derived from the token/org id. */
  region: Region;
}

/**
 * Authenticate against Fullstory's production OAuth 2.1 server (heimdall,
 * auth.fullstory.com) using the standard native-app flow:
 *
 *   1. Dynamically register a public client (RFC 7591) unless a
 *      pre-registered client id is configured.
 *   2. Authorization-code + PKCE (S256), loopback redirect (RFC 8252) —
 *      we listen on an ephemeral 127.0.0.1 port for the callback. The
 *      request carries the RFC 8707 resource indicator for the Subtext MCP
 *      resource, which selects Subtext branding on the OAuth pages.
 *   3. Exchange the code at /oauth/token (public client, no secret).
 *
 * The access token is `<realm>.oauth!<JWT>`; the JWT payload carries
 * `org_id` and `sub` (user email), so no extra "who am I" call is needed.
 */
export async function authenticate(options: WizardOptions): Promise<SubtextAuth> {
  if (options.apiKey) {
    p.log.info('Using the token you provided — skipping browser login.');
    const claims = decodeTokenClaims(options.apiKey);
    if (!claims?.orgId) {
      // Non-OAuth API keys are org-scoped but opaque; there is no public
      // endpoint to resolve the org id from a key yet (see plan doc).
      throw new Error(
        '--api-key must be an OAuth access token issued by auth.fullstory.com. ' +
          'Run without --api-key to log in through the browser instead.',
      );
    }
    return {
      accessToken: options.apiKey,
      orgId: claims.orgId,
      userEmail: claims.userEmail,
      region: claims.region ?? options.region,
    };
  }

  if (options.mock) {
    p.log.step('Log in to Subtext to link this install to your org.');
    const spinner = p.spinner();
    spinner.start('Waiting for browser login (mock)');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    spinner.stop('Logged in as demo@example.com (mock)');
    return {
      accessToken: 'subtext_mock_token',
      orgId: 'o-1G1-na1',
      userEmail: 'demo@example.com',
      region: options.region,
    };
  }

  const authBase = authBaseUrl(options.region);
  const resource = subtextOauthResource(options.region);
  const clientId = oauthClientId(options.region) ?? (await registerClient(authBase));

  // Loopback server for the OAuth redirect.
  const { server, port, callbackPromise } = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const state = randomUUID();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorizeUrl = new URL(`${authBase}${OAUTH_AUTHORIZE_PATH}`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', resource);
  if (OAUTH_SCOPES) authorizeUrl.searchParams.set('scope', OAUTH_SCOPES);

  p.log.step('Log in to Subtext to link this install to your org.');
  p.log.info(`If your browser doesn't open, visit:\n${pc.cyan(authorizeUrl.toString())}`);

  try {
    await open(authorizeUrl.toString());
  } catch {
    // URL is printed above; the user can open it manually.
  }

  const spinner = p.spinner();
  spinner.start('Waiting for you to finish logging in…');

  let code: string;
  try {
    const callback = await waitForCallback(callbackPromise, spinner);
    if (callback.state !== state) {
      throw new Error('OAuth state mismatch — aborting login for safety. Re-run the installer.');
    }
    if (callback.error) {
      throw new Error(`Login was not completed: ${callback.error}`);
    }
    code = callback.code!;
  } catch (error) {
    spinner.stop('Login failed.', 1);
    throw error;
  } finally {
    server.close();
  }

  const token = await exchangeCode(authBase, {
    code,
    clientId,
    redirectUri,
    verifier,
    resource,
  }).catch((error) => {
    spinner.stop('Login failed.', 1);
    throw error;
  });

  const claims = decodeTokenClaims(token.access_token);
  if (!claims?.orgId) {
    spinner.stop('Login failed.', 1);
    throw new Error('Could not read the org id from the access token.');
  }

  spinner.stop(
    `Logged in${claims.userEmail ? ` as ${claims.userEmail}` : ''} (org ${claims.orgId}).`,
  );

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    orgId: claims.orgId,
    userEmail: claims.userEmail,
    region: claims.region ?? options.region,
  };
}

/**
 * Waits for the OAuth loopback callback. After AUTH_PROMPT_AFTER_MS of
 * silence, asks whether to keep waiting instead of giving up — a first-time
 * signup detours through email verification and password setup, which takes
 * far longer than any reasonable silent timeout, and the flow can only
 * complete if this process keeps listening. Gives up for good once
 * AUTH_CALLBACK_TIMEOUT_MS elapses.
 */
async function waitForCallback(
  callbackPromise: Promise<CallbackResult>,
  spinner: ReturnType<typeof p.spinner>,
): Promise<CallbackResult> {
  const deadline = Date.now() + AUTH_CALLBACK_TIMEOUT_MS;
  for (;;) {
    const waitMs = Math.min(AUTH_PROMPT_AFTER_MS, deadline - Date.now());
    if (waitMs <= 0) {
      throw new Error('Timed out waiting for browser login. Re-run the installer to try again.');
    }
    const result = await Promise.race([
      callbackPromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), waitMs).unref()),
    ]);
    if (result !== 'timeout') {
      return result;
    }

    spinner.stop('Still waiting for browser login.');
    const keepWaiting = await Promise.race([
      callbackPromise,
      p.confirm({
        message:
          'Keep waiting? (If you just created an account, finish the email verification ' +
          'and password steps in your browser — this window will pick the login back up.)',
      }),
    ]);
    if (typeof keepWaiting === 'object') {
      // The callback arrived while the prompt was up.
      spinner.start('Finishing login…');
      return keepWaiting;
    }
    if (p.isCancel(keepWaiting) || !keepWaiting) {
      spinner.start('Waiting for you to finish logging in…');
      throw new Error('Login canceled. Re-run the installer to try again.');
    }
    spinner.start('Waiting for you to finish logging in…');
  }
}

/** RFC 7591 dynamic client registration — same call MCP clients make. */
async function registerClient(authBase: string): Promise<string> {
  const res = await fetch(`${authBase}${OAUTH_REGISTER_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Subtext Install (npx @subtext/install)',
      redirect_uris: ['http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`OAuth client registration failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
}

async function startCallbackServer(): Promise<{
  server: http.Server;
  port: number;
  callbackPromise: Promise<CallbackResult>;
}> {
  let resolveCallback!: (result: CallbackResult) => void;
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      error
        ? '<html><body><h2>Login didn&rsquo;t complete</h2><p>Close this tab, return to your terminal, and re-run <code>npx @subtext/install</code> to try again.</p></body></html>'
        : '<html><body><h2>Logged in to Subtext</h2><p>You can close this tab and return to the terminal.</p></body></html>',
    );
    resolveCallback({
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      error: error
        ? `${error}${url.searchParams.get('error_description') ? `: ${url.searchParams.get('error_description')}` : ''}`
        : undefined,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port, callbackPromise };
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

async function exchangeCode(
  authBase: string,
  args: { code: string; clientId: string; redirectUri: string; verifier: string; resource: string },
): Promise<TokenResponse> {
  const res = await fetch(`${authBase}${OAUTH_TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: args.clientId,
      code_verifier: args.verifier,
      // RFC 8707: the token request repeats the resource indicator from the
      // authorization request. Heimdall ignores it today (no audience
      // restriction yet) but MCP-spec clients send it on both requests.
      resource: args.resource,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Access tokens look like `<realm>.oauth!<JWT>`. The JWT payload includes
 * `org_id` (the org the token is scoped to) and `sub` (the user's email).
 */
export function decodeTokenClaims(
  token: string,
): { orgId?: string; userEmail?: string; region?: Region } | null {
  const bangIndex = token.indexOf('!');
  const realmPrefix = bangIndex > 0 ? token.slice(0, bangIndex) : '';
  const jwt = bangIndex > 0 ? token.slice(bangIndex + 1) : token;

  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      org_id?: string;
      sub?: string;
    };
    const region: Region | undefined = realmPrefix.startsWith('eu')
      ? 'eu'
      : realmPrefix
        ? 'us'
        : payload.org_id?.endsWith('-eu1')
          ? 'eu'
          : payload.org_id
            ? 'us'
            : undefined;
    return { orgId: payload.org_id, userEmail: payload.sub, region };
  } catch {
    return null;
  }
}
