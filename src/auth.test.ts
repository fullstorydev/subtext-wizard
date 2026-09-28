import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clackStub, makeOptions } from './test/helpers.js';

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

const open = vi.mocked((await import('open')).default);
const { authenticate, decodeTokenClaims, startCallbackServer } = await import('./auth.js');

// ---------------------------------------------------------------------------

/** Build an access token in the shape the OAuth server issues. */
function accessToken(payload: Record<string, unknown>, realmPrefix = 'na1.oauth'): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${b64({ alg: 'RS256' })}.${b64(payload)}.c2ln`;
  return realmPrefix ? `${realmPrefix}!${jwt}` : jwt;
}

/** A plain GET against the loopback callback, bypassing the stubbed fetch. */
function hit(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

/**
 * Access tokens look like `<realm>.oauth!<JWT>`. Reading org_id out of the
 * payload is what lets a supplied token skip the /me round trip, so every
 * malformed shape has to fail closed rather than yield a half-filled claim.
 */
describe('decodeTokenClaims', () => {
  it('reads the org and user out of a realm-prefixed token', () => {
    expect(decodeTokenClaims(accessToken({ org_id: 'o-1G1-na1', sub: 'dev@example.com' }))).toEqual({
      orgId: 'o-1G1-na1',
      userEmail: 'dev@example.com',
      region: 'us',
    });
  });

  it('takes the region from an eu realm prefix', () => {
    const token = accessToken({ org_id: 'o-2H2-eu1' }, 'eu1.oauth');
    expect(decodeTokenClaims(token)?.region).toBe('eu');
  });

  it('falls back to the org id suffix when there is no realm prefix', () => {
    expect(decodeTokenClaims(accessToken({ org_id: 'o-2H2-eu1' }, ''))?.region).toBe('eu');
    expect(decodeTokenClaims(accessToken({ org_id: 'o-1G1-na1' }, ''))?.region).toBe('us');
  });

  it('leaves the region undefined when there is nothing to infer it from', () => {
    expect(decodeTokenClaims(accessToken({}, ''))).toEqual({
      orgId: undefined,
      userEmail: undefined,
      region: undefined,
    });
  });

  it.each([
    ['too few segments', 'na1.oauth!header.payload'],
    ['not a JWT at all', 'just-an-api-key'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, token) => {
    expect(decodeTokenClaims(token)).toBeNull();
  });

  it('returns null when the payload is not JSON', () => {
    expect(decodeTokenClaims('na1.oauth!aGVhZGVy.bm90LWpzb24.c2ln')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * The loopback port is reachable by any local process or a drive-by web page.
 * Nothing is stealable either way (PKCE + unguessable state), but a stray or
 * forged first hit must not be able to abort a login in progress.
 */
describe('startCallbackServer', () => {
  let close: (() => void) | undefined;

  afterEach(() => close?.());

  async function serve(expectedState: string) {
    const started = await startCallbackServer(expectedState);
    close = () => started.server.close();
    return { ...started, origin: `http://127.0.0.1:${started.port}` };
  }

  it('resolves with the code when the state matches', async () => {
    const { origin, callbackPromise } = await serve('st-1');

    const res = await hit(`${origin}/callback?code=abc123&state=st-1`);

    expect(res.status).toBe(200);
    expect(res.body).toContain('Logged in to Subtext');
    await expect(callbackPromise).resolves.toEqual({
      code: 'abc123',
      state: 'st-1',
      error: undefined,
    });
  });

  it('404s any path other than /callback', async () => {
    const { origin } = await serve('st-1');
    expect((await hit(`${origin}/`)).status).toBe(404);
    expect((await hit(`${origin}/admin`)).status).toBe(404);
  });

  it('rejects a forged state with a 400 and keeps listening', async () => {
    const { origin, callbackPromise } = await serve('st-1');

    const forged = await hit(`${origin}/callback?code=evil&state=guessed`);
    expect(forged.status).toBe(400);

    // The real redirect still lands afterwards — the forged hit didn't
    // consume the one-shot.
    const real = await hit(`${origin}/callback?code=abc123&state=st-1`);
    expect(real.status).toBe(200);
    await expect(callbackPromise).resolves.toMatchObject({ code: 'abc123' });
  });

  it('rejects a callback with no state at all', async () => {
    const { origin } = await serve('st-1');
    expect((await hit(`${origin}/callback?code=abc123`)).status).toBe(400);
  });

  // A genuine error redirect from the auth server is let through even without
  // a matching state, so the user sees why the login failed.
  it('accepts an error redirect and folds in the description', async () => {
    const { origin, callbackPromise } = await serve('st-1');

    const res = await hit(
      `${origin}/callback?error=access_denied&error_description=User%20said%20no&state=st-1`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain('didn');
    await expect(callbackPromise).resolves.toMatchObject({
      error: 'access_denied: User said no',
    });
  });

  it('reports a bare error with no description', async () => {
    const { origin, callbackPromise } = await serve('st-1');
    await hit(`${origin}/callback?error=server_error&state=st-1`);
    await expect(callbackPromise).resolves.toMatchObject({ error: 'server_error' });
  });
});

// ---------------------------------------------------------------------------

describe('authenticate with a supplied credential', () => {
  it('uses an OAuth token as-is, with no network call', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const token = accessToken({ org_id: 'o-1G1-na1', sub: 'dev@example.com' });

    const auth = await authenticate(makeOptions({ apiKey: token, apiKeyKind: 'auto' }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(auth).toEqual({
      accessToken: token,
      authScheme: 'Bearer',
      orgId: 'o-1G1-na1',
      userEmail: 'dev@example.com',
      region: 'us',
    });
  });

  // --api-key-oauth promises an OAuth token. Falling through to the /me path
  // would silently give it --api-key's behavior, which is a different flag.
  it('refuses a non-OAuth value under --api-key-oauth', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      authenticate(makeOptions({ apiKey: 'plain-api-key', apiKeyKind: 'oauth' })),
    ).rejects.toThrow(/--api-key-oauth must be an OAuth access token/);
  });

  it('returns a canned org for an opaque key under --mock', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);

    const auth = await authenticate(
      makeOptions({ apiKey: 'plain-api-key', apiKeyKind: 'auto', mock: true }),
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(auth).toMatchObject({ authScheme: 'Basic', orgId: 'o-1G1-na1' });
  });

  it('returns a canned OAuth session under --mock with no credential', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);

    const pending = authenticate(makeOptions({ mock: true }));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(fetchFn).not.toHaveBeenCalled();
    await expect(pending).resolves.toMatchObject({
      authScheme: 'Bearer',
      orgId: 'o-1G1-na1',
      userEmail: 'demo@example.com',
    });
  });
});

/**
 * A normal API key is opaque — the only way to learn its org is to ask. It
 * goes as `Authorization: Basic`, which is Fullstory's documented form.
 */
describe('authenticate resolving an opaque API key via /me', () => {
  function stubMe(response: Response | Error) {
    const fn = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    );
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  const opaque = (key = 'na1.abc123') => makeOptions({ apiKey: key, apiKeyKind: 'auto' });

  it('sends the key as Basic and reads the org back', async () => {
    const fetchFn = stubMe(jsonResponse({ orgId: 'o-1G1-na1', email: 'dev@example.com' }));

    const auth = await authenticate(opaque());

    expect(fetchFn.mock.calls[0][0]).toBe('https://api.fullstory.com/me');
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Basic na1.abc123',
    });
    expect(auth).toMatchObject({
      authScheme: 'Basic',
      orgId: 'o-1G1-na1',
      userEmail: 'dev@example.com',
      region: 'us',
    });
  });

  it('picks the host from an eu1 key prefix', async () => {
    const fetchFn = stubMe(jsonResponse({ orgId: 'o-2H2-eu1' }));
    await authenticate(opaque('eu1.abc123'));
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.eu1.fullstory.com/me');
  });

  it('falls back to the requested region for a legacy key with no prefix', async () => {
    const fetchFn = stubMe(jsonResponse({ orgId: 'o-1G1-na1' }));
    await authenticate({ ...opaque('legacykey'), region: 'us' });
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.fullstory.com/me');
  });

  // The org id is authoritative for the realm, whatever host answered.
  it('lets an -eu1 org id override the region', async () => {
    stubMe(jsonResponse({ orgId: 'o-2H2-eu1' }));
    const auth = await authenticate(opaque('legacykey'));
    expect(auth.region).toBe('eu');
  });

  it('treats an empty email as absent', async () => {
    stubMe(jsonResponse({ orgId: 'o-1G1-na1', email: '' }));
    expect((await authenticate(opaque())).userEmail).toBeUndefined();
  });

  it.each([401, 403])('explains a %d as a rejected key', async (status) => {
    stubMe(new Response('', { status }));
    await expect(authenticate(opaque())).rejects.toThrow(
      new RegExp(`--api-key was rejected \\(${status}\\)`),
    );
  });

  it('reports any other non-2xx by status', async () => {
    stubMe(new Response('', { status: 503 }));
    await expect(authenticate(opaque())).rejects.toThrow(/\/me returned 503/);
  });

  it('fails when the response carries no orgId', async () => {
    stubMe(jsonResponse({ email: 'dev@example.com' }));
    await expect(authenticate(opaque())).rejects.toThrow(/did not include an orgId/);
  });

  it('fails when the response is not JSON', async () => {
    stubMe(new Response('<html>nope</html>', { status: 200 }));
    await expect(authenticate(opaque())).rejects.toThrow(/did not include an orgId/);
  });

  it('names the host it could not reach', async () => {
    stubMe(new Error('ECONNREFUSED'));
    await expect(authenticate(opaque())).rejects.toThrow(
      /Could not reach https:\/\/api\.fullstory\.com\/me .*ECONNREFUSED/s,
    );
  });
});

// ---------------------------------------------------------------------------

/**
 * The full native-app flow: dynamic client registration, authorization-code
 * with PKCE over a loopback redirect, then the token exchange. Driven for
 * real — the wizard's own loopback server receives an actual HTTP request.
 */
describe('authenticate over the browser flow', () => {
  const TOKEN = accessToken({ org_id: 'o-1G1-na1', sub: 'dev@example.com' });

  /** Route the two OAuth POSTs; anything else is an unexpected call. */
  function stubOAuth(overrides: { register?: Response; token?: Response } = {}) {
    return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/oauth/register')) {
        return overrides.register ?? jsonResponse({ client_id: 'dyn-client-1' });
      }
      if (url.endsWith('/oauth/token')) {
        return (
          overrides.token ??
          jsonResponse({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 })
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
  }

  /** Run authenticate() and deliver a callback once the authorize URL is up. */
  async function runFlow(
    deliver: (params: { origin: string; state: string }) => Promise<unknown>,
    options = makeOptions(),
    openBrowser = true,
  ) {
    const pending = authenticate(options, openBrowser);
    // Swallow a rejection until the assertion awaits it, so a failing flow
    // doesn't surface as an unhandled rejection first.
    pending.catch(() => {});

    await vi.waitFor(() => expect(clack.log.info).toHaveBeenCalled());
    const printed = clack.log.info.mock.calls.map((c) => String(c[0])).join('\n');
    const authorizeUrl = new URL(printed.match(/https:\/\/auth\.fullstory\.com\S+/)![0]);
    const redirect = new URL(authorizeUrl.searchParams.get('redirect_uri')!);

    await deliver({
      origin: redirect.origin,
      state: authorizeUrl.searchParams.get('state')!,
    });
    return { pending, authorizeUrl };
  }

  it('registers a client, runs PKCE, and returns the exchanged token', async () => {
    const fetchFn = stubOAuth();
    vi.stubGlobal('fetch', fetchFn);

    const { pending, authorizeUrl } = await runFlow(({ origin, state }) =>
      hit(`${origin}/callback?code=the-code&state=${state}`),
    );

    await expect(pending).resolves.toEqual({
      accessToken: TOKEN,
      authScheme: 'Bearer',
      refreshToken: undefined,
      orgId: 'o-1G1-na1',
      userEmail: 'dev@example.com',
      region: 'us',
    });

    // The authorization request carries everything the flow depends on.
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('dyn-client-1');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(authorizeUrl.searchParams.get('resource')).toBe(
      'https://api.fullstory.com/mcp/subtext',
    );
    expect(authorizeUrl.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
  });

  it('opens the browser, and only prints the link when the user declined', async () => {
    vi.stubGlobal('fetch', stubOAuth());
    const { pending } = await runFlow(
      ({ origin, state }) => hit(`${origin}/callback?code=c&state=${state}`),
      makeOptions(),
      false,
    );
    await pending;
    expect(open).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.stubGlobal('fetch', stubOAuth());
    const second = await runFlow(({ origin, state }) =>
      hit(`${origin}/callback?code=c&state=${state}`),
    );
    await second.pending;
    expect(open).toHaveBeenCalledOnce();
  });

  it('sends the verifier and the resource indicator on the token exchange', async () => {
    const fetchFn = stubOAuth();
    vi.stubGlobal('fetch', fetchFn);

    const { pending, authorizeUrl } = await runFlow(({ origin, state }) =>
      hit(`${origin}/callback?code=the-code&state=${state}`),
    );
    await pending;

    const exchange = fetchFn.mock.calls.find((c) => String(c[0]).endsWith('/oauth/token'))!;
    const body = new URLSearchParams(String(exchange[1]?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('client_id')).toBe('dyn-client-1');
    expect(body.get('resource')).toBe('https://api.fullstory.com/mcp/subtext');
    expect(body.get('redirect_uri')).toBe(authorizeUrl.searchParams.get('redirect_uri'));
    expect(body.get('code_verifier')).toMatch(/^[\w-]{43}$/);
  });

  it('keeps the refresh token when the server issues one', async () => {
    vi.stubGlobal(
      'fetch',
      stubOAuth({
        token: jsonResponse({ access_token: TOKEN, token_type: 'Bearer', refresh_token: 'rt-1' }),
      }),
    );
    const { pending } = await runFlow(({ origin, state }) =>
      hit(`${origin}/callback?code=c&state=${state}`),
    );
    await expect(pending).resolves.toMatchObject({ refreshToken: 'rt-1' });
  });

  it('fails when client registration is refused', async () => {
    vi.stubGlobal('fetch', stubOAuth({ register: new Response('rate limited', { status: 429 }) }));
    await expect(authenticate(makeOptions())).rejects.toThrow(
      /OAuth client registration failed \(429\)/,
    );
  });

  it('fails when the token exchange is refused', async () => {
    vi.stubGlobal('fetch', stubOAuth({ token: new Response('bad code', { status: 400 }) }));
    const { pending } = await runFlow(({ origin, state }) =>
      hit(`${origin}/callback?code=c&state=${state}`),
    );
    await expect(pending).rejects.toThrow(/Token exchange failed \(400\)/);
  });

  it('fails when the issued token carries no org', async () => {
    vi.stubGlobal(
      'fetch',
      stubOAuth({ token: jsonResponse({ access_token: accessToken({}, ''), token_type: 'Bearer' }) }),
    );
    const { pending } = await runFlow(({ origin, state }) =>
      hit(`${origin}/callback?code=c&state=${state}`),
    );
    await expect(pending).rejects.toThrow(/Could not read the org id/);
  });

  /**
   * Current behaviour, recorded rather than endorsed: authenticate() compares
   * state before it looks at `error`, so an error redirect that omits the
   * state reports a mismatch instead of the server's reason. Real OAuth
   * servers echo state on error redirects, so this is a rough edge on an
   * unlikely path — see the PR discussion.
   */
  it('reports the server reason when an error redirect echoes the state', async () => {
    vi.stubGlobal('fetch', stubOAuth());
    const { pending } = await runFlow(({ origin, state }) =>
      hit(`${origin}/callback?error=access_denied&state=${state}`),
    );
    await expect(pending).rejects.toThrow(/Login was not completed: access_denied/);
  });

  it('reports a state mismatch when an error redirect omits the state', async () => {
    vi.stubGlobal('fetch', stubOAuth());
    const { pending } = await runFlow(({ origin }) => hit(`${origin}/callback?error=access_denied`));
    await expect(pending).rejects.toThrow(/OAuth state mismatch/);
  });
});
