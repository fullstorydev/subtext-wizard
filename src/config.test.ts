import { describe, expect, it, vi } from 'vitest';

/**
 * config.ts snapshots SUBTEXT_DEV at import time, so anything that depends on
 * dev-mode has to be re-imported with the env already in place. loadConfig is
 * the pattern the rest of the suites reuse for import-time env reads.
 */
async function loadConfig(env: Record<string, string | undefined> = {}) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, '');
    else vi.stubEnv(key, value);
  }
  vi.resetModules();
  return import('./config.js');
}

describe('host resolution', () => {
  it('points at the US hosts by default', async () => {
    const config = await loadConfig();
    expect(config.authBaseUrl('us')).toBe('https://auth.fullstory.com');
    expect(config.apiBaseUrl('us')).toBe('https://api.fullstory.com');
    expect(config.appBaseUrl('us')).toBe('https://app.fullstory.com');
    expect(config.captureHosts('us')).toEqual({
      host: 'fullstory.com',
      script: 'edge.fullstory.com/s/fs.js',
    });
  });

  it('points at the EU hosts for an EU org', async () => {
    const config = await loadConfig();
    expect(config.authBaseUrl('eu')).toBe('https://auth.eu1.fullstory.com');
    expect(config.apiBaseUrl('eu')).toBe('https://api.eu1.fullstory.com');
    expect(config.captureHosts('eu')).toEqual({
      host: 'eu1.fullstory.com',
      script: 'edge.eu1.fullstory.com/s/fs.js',
    });
  });

  it('derives the telemetry URL and the OAuth resource indicator from the API host', async () => {
    const config = await loadConfig();
    expect(config.telemetryUrl('us')).toBe('https://api.fullstory.com/subtext/telemetry');
    expect(config.subtextOauthResource('us')).toBe('https://api.fullstory.com/mcp/subtext');
  });
});

/**
 * The wizard runs inside project directories the user may not fully trust, and
 * those commonly auto-load env (direnv, mise, dotenv shells). A poisoned
 * SUBTEXT_*_URL could redirect login to a phishing page or swap the capture
 * snippet for attacker JS, so overrides must be inert without SUBTEXT_DEV=1.
 */
describe('dev host overrides', () => {
  it('ignores an override when dev mode is off', async () => {
    const config = await loadConfig({ SUBTEXT_AUTH_BASE_URL: 'http://evil.test' });
    expect(config.authBaseUrl('us')).toBe('https://auth.fullstory.com');
  });

  it('honors an override only under SUBTEXT_DEV=1', async () => {
    const config = await loadConfig({
      SUBTEXT_DEV: '1',
      SUBTEXT_AUTH_BASE_URL: 'http://localhost:9000',
      SUBTEXT_TELEMETRY_URL: 'http://localhost:9000/t',
    });
    expect(config.authBaseUrl('us')).toBe('http://localhost:9000');
    expect(config.telemetryUrl('us')).toBe('http://localhost:9000/t');
  });

  it('treats SUBTEXT_DEV set to anything but "1" as off', async () => {
    const config = await loadConfig({
      SUBTEXT_DEV: 'true',
      SUBTEXT_API_BASE_URL: 'http://evil.test',
    });
    expect(config.apiBaseUrl('us')).toBe('https://api.fullstory.com');
  });
});

describe('warnOnDevOverrides', () => {
  function captureStderr() {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return () => write.mock.calls.map((c) => String(c[0])).join('');
  }

  it('says nothing when no override is set', async () => {
    const config = await loadConfig();
    const output = captureStderr();
    config.warnOnDevOverrides();
    expect(output()).toBe('');
  });

  it('names the active overrides under dev mode', async () => {
    const config = await loadConfig({
      SUBTEXT_DEV: '1',
      SUBTEXT_APP_BASE_URL: 'http://localhost:3000',
    });
    const output = captureStderr();
    config.warnOnDevOverrides();
    expect(output()).toContain('SUBTEXT_DEV=1');
    expect(output()).toContain('SUBTEXT_APP_BASE_URL=http://localhost:3000');
  });

  // The security-relevant case: a poisoned env must never redirect a run
  // silently, so the ignored override is announced too.
  it('announces an override it is ignoring', async () => {
    const config = await loadConfig({ SUBTEXT_AUTH_BASE_URL: 'http://evil.test' });
    const output = captureStderr();
    config.warnOnDevOverrides();
    expect(output()).toMatch(/Ignoring SUBTEXT_AUTH_BASE_URL/);
    expect(output()).toContain('require SUBTEXT_DEV=1');
  });
});

describe('telemetryOptedOutByEnv', () => {
  it('returns undefined when neither var is set', async () => {
    const config = await loadConfig();
    expect(config.telemetryOptedOutByEnv()).toBeUndefined();
  });

  it.each(['1', 'true', 'yes'])('opts out on DO_NOT_TRACK=%s', async (value) => {
    const config = await loadConfig({ DO_NOT_TRACK: value });
    expect(config.telemetryOptedOutByEnv()).toBe('DO_NOT_TRACK');
  });

  it('opts out on DISABLE_TELEMETRY', async () => {
    const config = await loadConfig({ DISABLE_TELEMETRY: '1' });
    expect(config.telemetryOptedOutByEnv()).toBe('DISABLE_TELEMETRY');
  });

  // The DO_NOT_TRACK convention: empty, "0" and "false" all mean "not set".
  it.each(['', '0', 'false', 'FALSE'])('treats DO_NOT_TRACK=%j as not set', async (value) => {
    const config = await loadConfig({ DO_NOT_TRACK: value });
    expect(config.telemetryOptedOutByEnv()).toBeUndefined();
  });
});

describe('oauthClientId', () => {
  it('falls back to dynamic registration when nothing is pre-registered', async () => {
    const config = await loadConfig();
    expect(config.oauthClientId('us')).toBeUndefined();
  });

  it('honors the env override', async () => {
    const config = await loadConfig({ SUBTEXT_OAUTH_CLIENT_ID: 'client-123' });
    expect(config.oauthClientId('us')).toBe('client-123');
  });
});

describe('WIZARD_VERSION', () => {
  it('reads the published package version', async () => {
    const [config, pkg] = await Promise.all([
      loadConfig(),
      import('../package.json', { with: { type: 'json' } }),
    ]);
    expect(config.WIZARD_VERSION).toBe(pkg.default.version);
  });
});
