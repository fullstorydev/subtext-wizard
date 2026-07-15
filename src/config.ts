/**
 * Central configuration.
 *
 * Auth and snippet endpoints are REAL production Fullstory endpoints
 * (verified against the mn monorepo: heimdall OAuth service and the public
 * snippet service). Anything still marked PLACEHOLDER has no backend yet.
 */

export const WIZARD_VERSION = '0.1.2';

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

/** App frontend host, realm-aware. Hosts the signed-in UI and signup pages. */
export function appBaseUrl(region: Region): string {
  if (process.env.SUBTEXT_APP_BASE_URL) return process.env.SUBTEXT_APP_BASE_URL;
  return region === 'eu' ? 'https://app.eu1.fullstory.com' : 'https://app.fullstory.com';
}

/**
 * TEMPORARY: the Subtext-themed account creation page (webber
 * `/subtext/signup`). Used to hand new users an account before the OAuth
 * login below — remove once OAuth-native signup lands and drop the offer in
 * run.ts with it.
 */
export const SUBTEXT_SIGNUP_PATH = '/subtext/signup';

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
 * OAuth client id for the wizard. When unset, the wizard dynamically
 * registers itself (RFC 7591) on each run — this works today but a
 * pre-registered first-party client id should replace it (see plan doc).
 */
export const OAUTH_CLIENT_ID = process.env.SUBTEXT_OAUTH_CLIENT_ID;

/**
 * Scopes requested during authorization. The install itself needs none of
 * the data APIs (the snippet endpoint is public), so we request the minimal
 * read scope the OAuth server offers today. TODO: confirm final scope set —
 * tracked in the plan doc.
 */
export const OAUTH_SCOPES = process.env.SUBTEXT_OAUTH_SCOPES ?? 'sessions:read';

/** Public, unauthenticated snippet endpoint (snippet service). `type=CORE`
 * returns the full inline snippet body for a <script> tag. */
export const SNIPPET_PATH = '/code/v2/snippet';

/**
 * Telemetry ingestion endpoint (lidar, fronted by gangplank). Accepts a
 * protojson `WorkflowEvent` and requires an authenticated session — we send
 * the user's OAuth access token as `Authorization: Bearer`.
 */
const TELEMETRY_PATH = '/subtext/telemetry';

export function telemetryUrl(region: Region): string {
  if (process.env.SUBTEXT_TELEMETRY_URL) return process.env.SUBTEXT_TELEMETRY_URL;
  return `${apiBaseUrl(region)}${TELEMETRY_PATH}`;
}

export const AUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;

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
