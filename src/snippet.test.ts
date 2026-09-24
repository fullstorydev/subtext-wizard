import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clackStub, makeOptions } from './test/helpers.js';
import type { SubtextAuth } from './auth.js';

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const { fetchCaptureSnippet } = await import('./snippet.js');

const auth: SubtextAuth = {
  accessToken: 'token',
  authScheme: 'Bearer',
  orgId: 'o-1G1-na1',
  region: 'us',
};

/** A body shaped like the real snippet service response. */
const validBody = `window['_fs_org']='o-1G1-na1';(function(m,n){/* ... */})(window,document);`;

function stubFetch(body: string, status = 200) {
  // Declaring the params (rather than `async () => …`) is what gives
  // fn.mock.calls a typed tuple, so the URL assertions below type-check.
  const fn = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(body, { status })),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCaptureSnippet', () => {
  it('returns the packaged placeholder in mock mode without touching the network', async () => {
    const fetchFn = stubFetch(validBody);
    const snippet = await fetchCaptureSnippet(auth, makeOptions({ mock: true }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(snippet).toContain("_fs_org");
    expect(snippet.startsWith('<script>')).toBe(true);
  });

  it('asks the snippet service for the org, realm hosts, and the CORE type', async () => {
    const fetchFn = stubFetch(validBody);
    await fetchCaptureSnippet(auth, makeOptions());

    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.origin).toBe('https://api.fullstory.com');
    expect(url.pathname).toBe('/code/v2/snippet');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      org: 'o-1G1-na1',
      type: 'CORE',
      host: 'fullstory.com',
      script: 'edge.fullstory.com/s/fs.js',
      namespace: 'FS',
    });
  });

  it('uses the EU hosts for an EU org', async () => {
    const fetchFn = stubFetch(validBody);
    await fetchCaptureSnippet({ ...auth, region: 'eu' }, makeOptions());

    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.origin).toBe('https://api.eu1.fullstory.com');
    expect(url.searchParams.get('host')).toBe('eu1.fullstory.com');
  });

  it('wraps the body in a script tag', async () => {
    stubFetch(`  ${validBody}  `);
    expect(await fetchCaptureSnippet(auth, makeOptions())).toBe(
      `<script>\n${validBody}\n</script>`,
    );
  });

  it('rejects a non-2xx response', async () => {
    stubFetch('nope', 503);
    await expect(fetchCaptureSnippet(auth, makeOptions())).rejects.toThrow(/returned 503/);
  });

  it('rejects a response that carries no _fs_org assignment', async () => {
    stubFetch('<html>login required</html>');
    await expect(fetchCaptureSnippet(auth, makeOptions())).rejects.toThrow(/unexpected response shape/);
  });

  // The snippet is interpolated into a fenced ```html block in a prompt handed
  // to an auto-approving agent. A backtick or a closing </script> would let a
  // tampered response break out of the fence and inject instructions.
  it('rejects a body containing a backtick', async () => {
    stubFetch(`${validBody}\`alert(1)\``);
    await expect(fetchCaptureSnippet(auth, makeOptions())).rejects.toThrow(
      /unexpected characters/,
    );
  });

  it.each(['</script>', '</SCRIPT >', '</script foo'])(
    'rejects a body containing %s',
    async (payload) => {
      stubFetch(`${validBody}${payload}`);
      await expect(fetchCaptureSnippet(auth, makeOptions())).rejects.toThrow(
        /unexpected characters/,
      );
    },
  );

  it('names the endpoint and the --mock escape hatch when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(fetchCaptureSnippet(auth, makeOptions())).rejects.toThrow(
      /https:\/\/api\.fullstory\.com\/code\/v2\/snippet.*ECONNREFUSED.*--mock/s,
    );
  });
});
