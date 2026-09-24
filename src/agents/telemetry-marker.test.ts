import { describe, expect, it, vi } from 'vitest';
import {
  TELEMETRY_MARKER_PREFIX,
  extractTelemetryMarkers,
  makeMarkerLineFilter,
  parseTelemetryMarker,
  type StepMarker,
} from './telemetry-marker.js';

/**
 * Marker lines come off an untrusted stream — the agent echoes arbitrary repo
 * content — and whatever survives parsing is sent to an authenticated
 * endpoint with the wizard's own token. So the allowlists and caps here are a
 * security boundary, not just parsing.
 */

const marker = (payload: unknown) => `${TELEMETRY_MARKER_PREFIX} ${JSON.stringify(payload)}`;

describe('parseTelemetryMarker', () => {
  it('parses a well-formed marker', () => {
    expect(
      parseTelemetryMarker(
        marker({ step: 'install', outcome: 'success', metadata: { framework: 'next' } }),
      ),
    ).toEqual({ step: 'install', outcome: 'success', metadata: { framework: 'next' } });
  });

  it('ignores a line with no marker prefix', () => {
    expect(parseTelemetryMarker('just some agent chatter')).toBeNull();
  });

  it('finds the payload behind a log gutter and trailing punctuation', () => {
    const line = `12:04:11 INFO  \`${marker({ step: 'plan', outcome: 'success' })}\`.`;
    expect(parseTelemetryMarker(line)).toEqual({
      step: 'plan',
      outcome: 'success',
      metadata: undefined,
    });
  });

  it.each(['start', 'complete'])('rejects the wizard-owned bookend %s', (step) => {
    expect(parseTelemetryMarker(marker({ step }))).toBeNull();
  });

  it('rejects an unknown step', () => {
    expect(parseTelemetryMarker(marker({ step: 'exfiltrate' }))).toBeNull();
  });

  it('drops an unknown outcome but keeps the step', () => {
    expect(parseTelemetryMarker(marker({ step: 'explore', outcome: 'totally-fine' }))).toEqual({
      step: 'explore',
      outcome: undefined,
      metadata: undefined,
    });
  });

  it('returns null on malformed JSON', () => {
    expect(parseTelemetryMarker(`${TELEMETRY_MARKER_PREFIX} {"step":`)).toBeNull();
  });

  it('returns null when there is no JSON object at all', () => {
    expect(parseTelemetryMarker(`${TELEMETRY_MARKER_PREFIX} install succeeded`)).toBeNull();
  });
});

describe('marker metadata sanitization', () => {
  it('drops keys outside the allowlist', () => {
    const parsed = parseTelemetryMarker(
      marker({ step: 'install', metadata: { framework: 'vite', harness: 'forged', secret: 'x' } }),
    );
    expect(parsed?.metadata).toEqual({ framework: 'vite' });
  });

  it('drops allowlisted keys carrying the wrong type', () => {
    const parsed = parseTelemetryMarker(
      marker({ step: 'explore', metadata: { csp_present: 'yes', framework: 42 } }),
    );
    expect(parsed?.metadata).toBeUndefined();
  });

  it('drops non-finite numbers', () => {
    const parsed = parseTelemetryMarker(
      `${TELEMETRY_MARKER_PREFIX} {"step":"install","metadata":{"duration_ms":1e999}}`,
    );
    expect(parsed?.metadata).toBeUndefined();
  });

  it('caps long strings at 128 chars', () => {
    const parsed = parseTelemetryMarker(
      marker({ step: 'install', metadata: { framework: 'z'.repeat(500) } }),
    );
    expect(parsed?.metadata?.framework).toHaveLength(128);
  });

  it('caps arrays at 32 entries and each entry at 128 chars', () => {
    const parsed = parseTelemetryMarker(
      marker({
        step: 'link_analytics',
        metadata: { analytics_providers: Array.from({ length: 80 }, () => 'p'.repeat(200)) },
      }),
    );
    expect(parsed?.metadata?.analytics_providers).toHaveLength(32);
    expect(parsed?.metadata?.analytics_providers?.[0]).toHaveLength(128);
  });

  it('drops non-string members of a string[] field', () => {
    const parsed = parseTelemetryMarker(
      marker({ step: 'link_analytics', metadata: { analytics_providers: ['posthog', 7, null] } }),
    );
    expect(parsed?.metadata?.analytics_providers).toEqual(['posthog']);
  });

  it('treats an array as no metadata at all', () => {
    expect(
      parseTelemetryMarker(marker({ step: 'install', metadata: ['framework'] }))?.metadata,
    ).toBeUndefined();
  });
});

describe('extractTelemetryMarkers', () => {
  it('strips marker lines and reports each one', () => {
    const seen: StepMarker[] = [];
    const text = [
      'Installing the snippet.',
      marker({ step: 'install', outcome: 'success' }),
      'Done.',
    ].join('\n');
    expect(extractTelemetryMarkers(text, (m) => seen.push(m))).toBe(
      'Installing the snippet.\nDone.',
    );
    expect(seen).toHaveLength(1);
  });

  it('returns the text untouched when no prefix is present', () => {
    const onMarker = vi.fn();
    expect(extractTelemetryMarkers('nothing here', onMarker)).toBe('nothing here');
    expect(onMarker).not.toHaveBeenCalled();
  });

  it('keeps a line that carries the prefix but fails to parse', () => {
    const onMarker = vi.fn();
    const junk = `${TELEMETRY_MARKER_PREFIX} not json`;
    expect(extractTelemetryMarkers(junk, onMarker)).toBe(junk);
    expect(onMarker).not.toHaveBeenCalled();
  });
});

describe('makeMarkerLineFilter', () => {
  it('consumes markers and echoes everything else', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const onMarker = vi.fn();
    const filter = makeMarkerLineFilter(onMarker);

    filter(marker({ step: 'precheck', outcome: 'skipped' }));
    filter('regular output');

    expect(onMarker).toHaveBeenCalledExactlyOnceWith({
      step: 'precheck',
      outcome: 'skipped',
      metadata: undefined,
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('regular output');
  });

  it('strips terminal control sequences out of echoed output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // OSC 52 is a clipboard write — an agent echoing repo content must not be
    // able to reach the user's clipboard through the wizard's own output.
    const osc52 = `]52;c;cGF5bG9hZA==safe text`;
    makeMarkerLineFilter()(osc52);
    expect(log.mock.calls[0][0]).toContain('safe text');
    expect(log.mock.calls[0][0]).not.toContain('52;c');
  });
});
