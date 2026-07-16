import { sanitizeTerminalOutput } from './helpers.js';
import type { WorkflowEventMetadata, WorkflowOutcome, WorkflowStep } from '../telemetry.js';

/**
 * How terminal agents report per-step telemetry WITHOUT ever touching a
 * credential: the prompt tells the agent to print marker lines to stdout, and
 * the wizard — which alone holds the OAuth token — parses them out of the
 * agent's output stream and sends the real WorkflowEvents itself. Nothing the
 * agent (or any install subprocess it spawns) can read carries the token.
 *
 * The stream is untrusted: the agent echoes output of arbitrary repo code
 * (install scripts, README contents), so everything a marker carries is
 * validated against an allowlist before it can reach the authenticated
 * telemetry endpoint.
 */
export const TELEMETRY_MARKER_PREFIX = '__SUBTEXT_TELEMETRY__';

/** Steps a terminal agent may self-report. `start` and `complete` are the
 * funnel bookends the wizard owns — excluded at the type level so no marker
 * producer can ever emit one. */
export type AgentWorkflowStep = Exclude<WorkflowStep, 'start' | 'complete'>;

const AGENT_STEPS: ReadonlySet<string> = new Set<AgentWorkflowStep>([
  'precheck',
  'explore',
  'plan',
  'install',
  'identify',
  'link_analytics',
  'mask_pii',
]);

const OUTCOMES: ReadonlySet<string> = new Set<WorkflowOutcome>([
  'success',
  'partial',
  'fail',
  'skipped',
]);

/** Per-field allowlist for marker metadata — the agent-reportable subset of
 * WorkflowEventMetadata (telemetry.ts) with its expected type. `harness` and
 * `model` are deliberately absent: the wizard stamps harness itself, so a
 * forged marker can never override attribution. Unknown keys and wrong-typed
 * values are dropped, strings and arrays are capped. */
const METADATA_FIELDS: Record<string, 'boolean' | 'number' | 'string' | 'string[]'> = {
  duration_ms: 'number',
  tokens: 'number',
  already_installed: 'boolean',
  framework: 'string',
  csp_present: 'boolean',
  approved: 'boolean',
  csp_modified: 'boolean',
  identity_added: 'boolean',
  analytics_providers: 'string[]',
  masked_count: 'number',
  privacy_check: 'boolean',
};
const MAX_STRING_LENGTH = 128;
const MAX_ARRAY_LENGTH = 32;

function sanitizeMetadata(raw: unknown): WorkflowEventMetadata | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(METADATA_FIELDS)) {
    const value = source[key];
    if (value === undefined) continue;
    if (kind === 'boolean' && typeof value === 'boolean') {
      out[key] = value;
    } else if (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (kind === 'string' && typeof value === 'string') {
      out[key] = value.slice(0, MAX_STRING_LENGTH);
    } else if (kind === 'string[]' && Array.isArray(value)) {
      out[key] = value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, MAX_ARRAY_LENGTH)
        .map((item) => item.slice(0, MAX_STRING_LENGTH));
    }
  }
  return Object.keys(out).length > 0 ? (out as WorkflowEventMetadata) : undefined;
}

export interface StepMarker {
  step: AgentWorkflowStep;
  outcome?: WorkflowOutcome;
  metadata?: WorkflowEventMetadata;
}

/**
 * Parse one line of agent output into a telemetry step, or null if it is not a
 * (valid, allowed) marker. Tolerates junk on both sides: indexOf finds the
 * prefix behind timestamps/ANSI/log gutters, and the payload is taken from the
 * first '{' to the last '}' so a marker wrapped in backticks or ending in
 * punctuation still parses. Unknown steps/outcomes, malformed JSON, and
 * disallowed metadata are dropped silently — telemetry must never disrupt the
 * install.
 */
export function parseTelemetryMarker(line: string): StepMarker | null {
  const at = line.indexOf(TELEMETRY_MARKER_PREFIX);
  if (at === -1) return null;
  const rest = line.slice(at + TELEMETRY_MARKER_PREFIX.length);
  const open = rest.indexOf('{');
  const close = rest.lastIndexOf('}');
  if (open === -1 || close <= open) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rest.slice(open, close + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.step !== 'string' || !AGENT_STEPS.has(obj.step)) return null;
  const outcome =
    typeof obj.outcome === 'string' && OUTCOMES.has(obj.outcome)
      ? (obj.outcome as WorkflowOutcome)
      : undefined;
  return { step: obj.step as AgentWorkflowStep, outcome, metadata: sanitizeMetadata(obj.metadata) };
}

/**
 * onStdoutLine handler for terminal agents whose raw output is piped through
 * the wizard (codex, gemini): consume marker lines, echo everything else to
 * the user's terminal unchanged.
 */
export function makeMarkerLineFilter(
  onMarker?: (marker: StepMarker) => void,
): (line: string) => void {
  return (line) => {
    const marker = parseTelemetryMarker(line);
    if (marker) onMarker?.(marker);
    else process.stdout.write(`${sanitizeTerminalOutput(line)}\n`);
  };
}

/**
 * Remove marker lines from a block of text (claude-code assistant blocks and
 * its final result note), reporting each parsed marker. Returns the text with
 * marker lines removed.
 */
export function extractTelemetryMarkers(
  text: string,
  onMarker?: (marker: StepMarker) => void,
): string {
  if (!text.includes(TELEMETRY_MARKER_PREFIX)) return text;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const marker = parseTelemetryMarker(line);
    if (marker) onMarker?.(marker);
    else kept.push(line);
  }
  return kept.join('\n');
}
