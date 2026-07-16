import fs from 'node:fs';
import * as p from '@clack/prompts';
import type { SubtextAuth } from './auth.js';
import {
  SNIPPET_PATH,
  apiBaseUrl,
  captureHosts,
  type WizardOptions,
} from './config.js';
import { packageRootPath } from './paths.js';

/**
 * Fetch the org-specific capture snippet from the public snippet service:
 *
 *   GET {api}/code/v2/snippet?org=<orgId>&type=CORE&host=…&script=…
 *
 * `type=CORE` returns the full inline snippet body (window['_fs_*']
 * assignments + IIFE) ready to wrap in a <script> tag. The endpoint is
 * public; the org id comes from the authenticated login.
 *
 * Caveat (tracked in the plan doc): this endpoint bakes in the standard
 * capture hosts for the org's realm. Orgs with custom script hosts or
 * first-party relays need an authenticated org-settings-aware endpoint,
 * which does not exist yet.
 */
export async function fetchCaptureSnippet(
  auth: SubtextAuth,
  options: WizardOptions,
): Promise<string> {
  const spinner = p.spinner();
  spinner.start('Fetching your org’s capture snippet…');

  if (options.mock) {
    const snippet = fs.readFileSync(
      packageRootPath('templates', 'mock-snippet.html'),
      'utf8',
    );
    spinner.stop(`Got capture snippet for org ${auth.orgId} (mock).`);
    return snippet.trim();
  }

  const hosts = captureHosts(auth.region);
  const url = new URL(`${apiBaseUrl(auth.region)}${SNIPPET_PATH}`);
  url.searchParams.set('org', auth.orgId);
  url.searchParams.set('type', 'CORE');
  url.searchParams.set('host', hosts.host);
  url.searchParams.set('script', hosts.script);
  url.searchParams.set('namespace', 'FS');

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`snippet endpoint returned ${res.status}`);
    }
    const body = (await res.text()).trim();
    if (!body.includes('_fs_org')) {
      throw new Error('unexpected response shape (no _fs_org assignment)');
    }
    // The snippet is wrapped in a <script> tag and interpolated into a fenced
    // ```html block in the agent prompt. A genuine snippet contains neither a
    // backtick nor a closing </script>; either would let a compromised/MITM'd
    // response break out of the fence and inject instructions into an
    // auto-approved agent. Reject rather than trust `_fs_org` alone.
    if (body.includes('`') || /<\/script/i.test(body)) {
      throw new Error('snippet contains unexpected characters (backtick or </script>)');
    }
    spinner.stop(`Got capture snippet for org ${auth.orgId}.`);
    return `<script>\n${body}\n</script>`;
  } catch (error) {
    spinner.stop('Could not fetch your capture snippet.', 1);
    throw new Error(
      `Failed to fetch the capture snippet from ${url.origin}${url.pathname}: ${
        error instanceof Error ? error.message : String(error)
      }. Re-run with --mock to try the flow with a placeholder snippet.`,
    );
  }
}
