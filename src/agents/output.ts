import pc from 'picocolors';
import { brandPink, pinkShade } from '../logo.js';

/**
 * Shared styling for a terminal agent's streamed output: every line the agent
 * prints gets a pink gutter bar, so the whole run reads as one visually
 * fenced block — clearly the agent talking, not the wizard. The bar's shade
 * drifts along the logo's pink ramp line by line, a slow shimmer flowing
 * down the margin that echoes the startup animation. Degradation (256-color,
 * no-color) is handled by pinkShade.
 */

let gutterLine = 0;

function gutter(): string {
  // Ping-pong along the ramp — one full deep→glow→deep sweep every ~24 lines.
  const t = (Math.sin((gutterLine++ * Math.PI) / 12) + 1) / 2;
  return pinkShade('┃', t);
}

/** Print a block of agent text (may span multiple lines), gutter-barred and dimmed. */
export function printAgentText(text: string): void {
  for (const line of text.split('\n')) {
    console.log(`${gutter()} ${pc.dim(line)}`);
  }
}

/** Print an agent action (tool use) — same gutter, pink arrow so actions pop. */
export function printAgentAction(text: string): void {
  console.log(`${gutter()} ${brandPink('→')} ${pc.dim(text)}`);
}
