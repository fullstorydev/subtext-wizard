import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { TELEMETRY_ENDPOINT, WIZARD_VERSION } from './config.js';

/**
 * Fire-and-forget telemetry. Events are POSTed in the background as they
 * happen; nothing ever blocks the wizard and failures are swallowed. A final
 * flush() with a short deadline runs at exit.
 *
 * The endpoint is a PLACEHOLDER — see config.ts.
 */
export class Telemetry {
  readonly runId = randomUUID();
  private pending: Promise<unknown>[] = [];
  private base: Record<string, unknown>;

  constructor(
    private enabled: boolean,
    private debug: boolean,
  ) {
    this.base = {
      wizard_version: WIZARD_VERSION,
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
      os_release: os.release(),
    };
  }

  /** Attach a property to every subsequent event (e.g. org id after login). */
  setTag(key: string, value: unknown): void {
    this.base[key] = value;
  }

  capture(event: string, properties: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    const payload = {
      event,
      run_id: this.runId,
      timestamp: new Date().toISOString(),
      properties: { ...this.base, ...properties },
    };
    if (this.debug) {
      console.error(`[telemetry] ${event} ${JSON.stringify(properties)}`);
    }
    const req = fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {
      /* telemetry must never break the wizard */
    });
    this.pending.push(req);
  }

  captureError(error: unknown, context: Record<string, unknown> = {}): void {
    const message = error instanceof Error ? error.message : String(error);
    this.capture('wizard_error', { ...context, error: message });
  }

  /** Wait briefly for in-flight events, then give up. */
  async flush(deadlineMs = 2_000): Promise<void> {
    if (!this.enabled || this.pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(this.pending),
      new Promise((resolve) => setTimeout(resolve, deadlineMs).unref?.()),
    ]);
  }
}
