import { WIZARD_VERSION } from './config.js';

/**
 * Fire-and-forget telemetry against the real `/subtext/telemetry` endpoint
 * (lidar). The endpoint accepts a protojson `WorkflowEvent` (lidar.proto) and
 * requires an authenticated session, so nothing can be delivered until the
 * user has logged in — call authorize() with the OAuth access token first.
 * Events are POSTed in the background as they happen; nothing ever blocks the
 * wizard and failures are swallowed. A final flush() with a short deadline
 * runs at exit.
 *
 * Known backend gaps (flagged for review, see PR description):
 * - No run-correlation id on WorkflowEvent, so wizard-side and agent-side
 *   events from one run can only be joined by org/email/time.
 * - No wizard-version or error-message metadata fields.
 * - Events fired before login (e.g. auth failures) cannot be delivered at all.
 */

/** Steps accepted by the endpoint — the lidar WorkflowStep enum. Anything
 * else is rejected with 400, so granular CLI milestones that don't map to a
 * step go through note() (debug-only) instead. */
export type WorkflowStep =
  | 'start'
  | 'precheck'
  | 'explore'
  | 'plan'
  | 'install'
  | 'identify'
  | 'link_analytics'
  | 'mask_pii'
  | 'complete';

/** The lidar Outcome enum; empty string means "in progress". */
export type WorkflowOutcome = 'success' | 'partial' | 'fail' | 'skipped';

/** protojson form of lidar's WorkflowEventMetadata. Field names mirror the
 * proto exactly (snake_case) so wizard-sent events and the MCP telemetry-event
 * tool all speak one convention. Fields are sparse — only those relevant to a
 * given step are set. */
export interface WorkflowEventMetadata {
  duration_ms?: number;
  tokens?: number;
  harness?: string;
  model?: string;
  already_installed?: boolean;
  framework?: string;
  csp_present?: boolean;
  approved?: boolean;
  csp_modified?: boolean;
  identity_added?: boolean;
  analytics_providers?: string[];
  masked_count?: number;
  privacy_check?: boolean;
  total_duration_ms?: number;
  total_tokens?: number;
}

export class Telemetry {
  private endpoint?: string;
  private accessToken?: string;
  private startSent = false;
  private pending: Promise<unknown>[] = [];
  private readonly startedAt = Date.now();

  constructor(
    private enabled: boolean,
    private debug: boolean,
  ) {}

  /** Enable delivery once the user is logged in. Events fired before this
   * are dropped (visible under --debug) — the endpoint rejects
   * unauthenticated requests, so there is nowhere to send them. */
  authorize(endpoint: string, accessToken: string): void {
    this.endpoint = endpoint;
    this.accessToken = accessToken;
  }

  /** Turn collection off for the rest of the run (user declined consent). */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Send one WorkflowEvent. `duration_ms` (on start) and `total_duration_ms`
   * (on complete) default to time since the wizard launched. The server
   * stamps org, email, and timestamp from the session.
   */
  step(step: WorkflowStep, outcome?: WorkflowOutcome, metadata: WorkflowEventMetadata = {}): void {
    if (!this.enabled) return;
    if (step === 'start') {
      this.startSent = true;
      metadata = { duration_ms: Date.now() - this.startedAt, ...metadata };
    } else if (step === 'complete') {
      metadata = { total_duration_ms: Date.now() - this.startedAt, ...metadata };
    }
    const payload = {
      workflow: 'onboard',
      step,
      ...(outcome ? { outcome } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
    if (this.debug) {
      console.error(`[telemetry] ${JSON.stringify(payload)}`);
    }
    if (!this.endpoint || !this.accessToken) return;
    const req = fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': `subtext-wizard/${WIZARD_VERSION}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {
      /* telemetry must never break the wizard */
    });
    this.pending.push(req);
  }

  /**
   * Report how the run ended. If the wizard died before reaching the agent
   * handoff, the funnel entry itself carries the outcome (start/fail or
   * start/skipped); after handoff it lands as a complete event instead.
   */
  finish(outcome: WorkflowOutcome, metadata: WorkflowEventMetadata = {}): void {
    this.step(this.startSent ? 'complete' : 'start', outcome, metadata);
  }

  /** Debug-only breadcrumb for CLI milestones that have no corresponding
   * WorkflowStep on the backend (auth_completed, agents_detected, tool use…).
   * Flagged for review — these are dropped, not sent. */
  note(event: string, properties: Record<string, unknown> = {}): void {
    if (this.debug) {
      console.error(`[telemetry:note] ${event} ${JSON.stringify(properties)}`);
    }
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
