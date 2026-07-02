export type AgentKind = 'terminal' | 'app';

export interface DetectedAgent {
  definition: AgentDefinition;
  /** Path to the CLI binary, when one was found. */
  binaryPath?: string;
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
}

export interface LaunchResult {
  /** 'ran' — agent executed to completion here; 'handoff' — user finishes in their app. */
  mode: 'ran' | 'handoff';
  exitCode?: number;
  /** Instructions to show the user after a handoff. */
  followUp?: string[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  kind: AgentKind;
  /** Returns detection info if this agent is installed, else null. */
  detect(): Promise<DetectedAgent | null>;
  launch(ctx: LaunchContext): Promise<LaunchResult>;
}
