import type { StepMarker } from './telemetry-marker.js';

export type AgentKind = 'terminal' | 'app';

export interface DetectedAgent {
  definition: AgentDefinition;
  /** Path to the CLI binary, when one was found. */
  binaryPath?: string;
  /** macOS app bundle name for GUI agents (e.g. "Cursor"), when the bundle was
   * found — lets us reopen the app for the demo/follow-up hand-off even when
   * there's no CLI launcher (Claude Desktop). */
  macAppName?: string;
  /** GUI agents only: whether launching this app takes the project directory
   * (Cursor/VS Code/Zed/Windsurf do; Claude Desktop doesn't). Controls whether
   * a reopen passes the folder so it focuses the project vs. a blank window. */
  opensFolder?: boolean;
  /** Extra detail shown in the picker (e.g. app bundle path). */
  detail?: string;
}

export interface LaunchContext {
  prompt: string;
  /** Directory of the app being instrumented. */
  cwd: string;
  binaryPath?: string;
  debug: boolean;
  onEvent?: (event: string, properties?: Record<string, unknown>) => void;
  /** Per-step telemetry the wizard parses out of the terminal agent's stdout
   * (see telemetry-marker.ts). The agent never holds a credential — it only
   * prints markers; the wizard sends the events with its own token. */
  onTelemetry?: (marker: StepMarker) => void;
}

/**
 * What the harness itself reported about a run, when it reports anything.
 * Claude Code's `stream-json` result event carries real token counts, cost,
 * turn count, and a subtype that says whether the model finished or hit the
 * turn limit; Codex and Gemini expose no structured stream, so their runs
 * simply carry no stats. `source` keeps the two apart: a measured count and a
 * model's self-estimate are not comparable, so never mix them in one metric.
 */
export interface HarnessRunStats {
  source: 'harness';
  /** Every token bucket the run consumed (input, output, and both cache
   * buckets), i.e. what the harness actually billed. */
  tokens?: number;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  /** Claude Code result subtype: 'success', 'error_max_turns',
   * 'error_during_execution'. */
  subtype?: string;
  /** The harness's own verdict that the run did not finish cleanly. This is the
   * signal exit code can't give us: a refused or abandoned run still exits 0. */
  isError?: boolean;
}

export interface LaunchResult {
  /** 'ran' — agent executed to completion here; 'handoff' — user finishes in their app. */
  mode: 'ran' | 'handoff';
  exitCode?: number;
  /** Set only by harnesses that report their own usage (Claude Code today). */
  stats?: HarnessRunStats;
  /** Instructions to show the user after a handoff. */
  followUp?: string[];
  /** Handoff only: the install prompt was copied to the clipboard, so later
   * clipboard offers (the demo prompt) must warn before clobbering it. */
  clipboardHoldsPrompt?: boolean;
}

export interface AgentDefinition {
  id: string;
  name: string;
  kind: AgentKind;
  /** For terminal agents: an honest, verb-phrase description of what the
   * autonomous run auto-approves ("auto-accepting file edits", "…and commands
   * inside its sandbox", …). Shown in the pre-launch confirmation so the user
   * consents to what actually happens — command execution included. */
  autonomy?: string;
  /** Returns detection info if this agent is installed, else null. */
  detect(): Promise<DetectedAgent | null>;
  launch(ctx: LaunchContext): Promise<LaunchResult>;
}
