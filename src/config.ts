/**
 * Central configuration.
 *
 * Auth and snippet endpoints are REAL production Fullstory endpoints
 * (verified against the mn monorepo: heimdall OAuth service and the public
 * snippet service). Anything still marked PLACEHOLDER has no backend yet —
 * see docs/notion-wizard-plan.md for the build-out plan.
 */

export const WIZARD_VERSION = '0.1.0';

export type Region = 'us' | 'eu';

/** OAuth 2.1 authorization server (heimdall). Discovery metadata lives at
 * `/.well-known/oauth-authorization-server`. */
export function authBaseUrl(region: Region): string {
  if (process.env.SUBTEXT_AUTH_BASE_URL) return process.env.SUBTEXT_AUTH_BASE_URL;
  return region === 'eu' ? 'https://auth.eu1.fullstory.com' : 'https://auth.fullstory.com';
}

/** Public API host, realm-aware. Serves the public snippet endpoint. */
export function apiBaseUrl(region: Region): string {
  if (process.env.SUBTEXT_API_BASE_URL) return process.env.SUBTEXT_API_BASE_URL;
  return region === 'eu' ? 'https://api.eu1.fullstory.com' : 'https://api.fullstory.com';
}

/** Capture hosts baked into the snippet, realm-aware. */
export function captureHosts(region: Region): { host: string; script: string } {
  return region === 'eu'
    ? { host: 'eu1.fullstory.com', script: 'edge.eu1.fullstory.com/s/fs.js' }
    : { host: 'fullstory.com', script: 'edge.fullstory.com/s/fs.js' };
}

export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';
export const OAUTH_TOKEN_PATH = '/oauth/token';
export const OAUTH_REGISTER_PATH = '/oauth/register';

/**
 * Pre-registered Subtext OAuth client ids, per realm. Populate once the
 * Subtext client is registered in each realm's heimdall — a stable
 * first-party client avoids polluting the client table and hitting the
 * registration rate limit with a fresh RFC 7591 registration on every run.
 * Until then the wizard falls back to dynamic registration. (Branding does
 * not depend on this: heimdall keys the Subtext-branded OAuth pages off the
 * RFC 8707 resource indicator — see subtextOauthResource below.)
 */
const PREREGISTERED_OAUTH_CLIENT_IDS: Partial<Record<Region, string>> = {
  // us: pending pre-registration
  // eu: pending pre-registration
};

/**
 * OAuth client id for the wizard. Resolution order: SUBTEXT_OAUTH_CLIENT_ID
 * env override → pre-registered per-realm client id → undefined, in which
 * case the wizard dynamically registers itself (RFC 7591) on each run.
 */
export function oauthClientId(region: Region): string | undefined {
  return process.env.SUBTEXT_OAUTH_CLIENT_ID ?? PREREGISTERED_OAUTH_CLIENT_IDS[region];
}

/**
 * Scopes requested during authorization. The install itself needs none of
 * the data APIs (the snippet endpoint is public), so we request the minimal
 * read scope the OAuth server offers today. TODO: confirm final scope set —
 * tracked in the plan doc.
 */
export const OAUTH_SCOPES = process.env.SUBTEXT_OAUTH_SCOPES ?? 'sessions:read';

/** Subtext MCP server endpoint, realm-aware. This is the URL agents connect
 * to once the plugin (or a manual MCP server entry) is configured. */
export function subtextMcpUrl(region: Region): string {
  return `${apiBaseUrl(region)}/mcp/subtext`;
}

/**
 * RFC 8707 resource indicator sent on the authorization and token requests,
 * identifying the Subtext MCP resource. Heimdall keys the Subtext branding
 * of its OAuth pages (login, consent) off this value's /mcp/subtext path —
 * see mn PR cowpaths/mn#106970 — and MCP clients send the same indicator,
 * so the wizard's login gets the same branded flow they do.
 */
export function subtextOauthResource(region: Region): string {
  return subtextMcpUrl(region);
}

/** Public, unauthenticated snippet endpoint (snippet service). `type=CORE`
 * returns the full inline snippet body for a <script> tag. */
export const SNIPPET_PATH = '/code/v2/snippet';

/** Telemetry ingestion endpoint, fire-and-forget. PLACEHOLDER — no backend
 * exists yet; see plan doc. */
export const TELEMETRY_ENDPOINT =
  process.env.SUBTEXT_TELEMETRY_URL ??
  'https://telemetry.subtext.fullstory.com/v1/wizard-events';

/**
 * How long the browser-login wait stays silent before asking the user whether
 * to keep waiting. Kept short enough that a stuck login surfaces quickly.
 */
export const AUTH_PROMPT_AFTER_MS = 5 * 60_000;

/**
 * Hard cap on the whole browser login. Deliberately long: a first-time signup
 * detours through email verification and password setup, and the loopback
 * server must still be listening when the OAuth flow restarts and delivers
 * the code afterwards.
 */
export const AUTH_CALLBACK_TIMEOUT_MS = 60 * 60_000;

export interface WizardOptions {
  /** Directory of the app being instrumented. Defaults to cwd. */
  dir: string;
  /** Skip network calls; return canned auth/snippet responses. */
  mock: boolean;
  /** Disable telemetry entirely. */
  telemetry: boolean;
  /** Data region for auth + API hosts. */
  region: Region;
  /** Pre-supplied access token; skips the browser login. */
  apiKey?: string;
  /** Pre-select an agent by id; skips the agent picker. */
  agent?: string;
  /** Pre-select integrations (comma-separated ids); skips the multiselect. */
  integrations?: string[];
  /** Build and print the prompt instead of launching an agent. */
  printPrompt: boolean;
  debug: boolean;
}
