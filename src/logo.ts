import pc from 'picocolors';

/**
 * The subtext avatar — a long central diagonal flanked by two offset bars —
 * rasterized from the brand-pack SVG into a braille dot matrix (2x4 dots per
 * cell) and set beside the SUBTEXT wordmark in half-block lettering (an homage
 * to classic ANSI/BBS scene fonts). The mark stands two rows taller than the
 * wordmark, which sits vertically centered against it. The two upper bars
 * render white (per CELL_MASK) while the down-left accent bar and the wordmark
 * carry the brand pink, all under one shimmer sweep that crosses them together.
 *
 * The animation is cosmetic-only and degrades gracefully: no TTY or no color
 * support prints the art statically; a terminal too small to hold it skips
 * the logo entirely so we never mangle the user's scrollback.
 */

// prettier-ignore
const RAW_ART = [
  '⠀⠀⠰⣾⣷⣤⡀⠀',
  '⣦⣄⠀⠀⠙⠻⠟⠃  ▄████▄ ██  ██ █████▄ ██████ ██████ ██  ██ ██████',
  '⠻⣿⣿⣶⣤⣀⠀⠀  ██▄▄▄▄ ██  ██ ██▄▄█▀   ██   ██▄▄▄▄  ▀██▀    ██',
  '⠀⠀⠉⠛⠿⣿⣷⣦  ▀▀▀▀██ ██  ██ ██  ██   ██   ██▀▀▀▀  ▄██▄    ██',
  '⢠⣴⣶⣤⡀⠈⠙⠻  ▀████▀ ▀████▀ █████▀   ██   ██████ ██  ██   ██',
  '⠀⠈⠙⠿⡿⠗⠀⠀',
];

// Per-cell color roles for the mark's braille cells: 'W' white, 'P' pink,
// '.' none. Aligns with the leading cells of each RAW_ART line; the wordmark
// (and everything past the mark) is left to the pink shimmer. The two upper
// bars read white; the down-left accent bar is the brand pink.
// prettier-ignore
const CELL_MASK = [
  '..WWWWW.',
  'WW..WWWW',
  'WWWWWW..',
  '..WWWWWW',
  'PPPPPWWW',
  '.PPPPP..',
];

type Rgb = readonly [number, number, number];

const DEEP_PINK: Rgb = [184, 27, 86];
const BASE_PINK: Rgb = [245, 68, 123]; // #F5447B, the brand accent
const GLOW: Rgb = [255, 216, 230];
const WHITE: Rgb = [236, 238, 245]; // cool white for the mark's upper bars

const FRAME_MS = 28;
const BAND_CORE = 3; // columns of full glow at the shimmer's center
const BAND_FALLOFF = 8; // columns over which glow fades back to base

/** Art lines with the common left margin removed and a small indent restored. */
function artLines(): string[] {
  const indent = Math.min(...RAW_ART.map((l) => l.length - l.trimStart().length));
  return RAW_ART.map((l) => `  ${l.slice(indent)}`);
}

/**
 * Color-role line for each art line, index-aligned with artLines() so a cell's
 * role is maskLines()[y][x]. Carries the 2-space indent plus the mark's mask;
 * every position past the mask (the gap and wordmark) defaults to '.', i.e. the
 * pink shimmer. 'W' cells render white, so only the down-left accent bar and the
 * wordmark stay pink.
 */
function maskLines(): string[] {
  return CELL_MASK.map((m) => `  ${m}`);
}

function colorMode(): 'truecolor' | '256' | 'none' {
  if (!pc.isColorSupported) return 'none';
  if (/truecolor|24bit/i.test(process.env.COLORTERM ?? '')) return 'truecolor';
  return '256';
}

function lerp(a: Rgb, b: Rgb, t: number): Rgb {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped),
  ];
}

function fg(rgb: Rgb): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

const RESET = '\x1b[0m';

/**
 * The logo's base pink, for inline text elsewhere in the wizard. 256-color
 * terminals get xterm 204 (the logo's own resting fallback); no-color output
 * passes through untouched. Closes with default-foreground, not a full reset,
 * so it composes inside other styling.
 */
export function brandPink(text: string): string {
  const mode = colorMode();
  if (mode === 'none') return text;
  const open = mode === '256' ? '\x1b[38;5;204m' : fg(BASE_PINK);
  return `${open}${text}\x1b[39m`;
}

/**
 * Render a note body at full strength. clack dims note bodies; wrapping each
 * line in a reset (the same escape clack uses for note titles) undoes that so
 * the text reads at normal weight — the styling the "First run" guide uses.
 * Any inline color (e.g. brandPink) applied to a line survives, since the
 * leading reset only clears the ambient dim before the line's own codes run.
 */
export function readableNoteBody(body: string): string {
  return body
    .split('\n')
    .map((line) => pc.reset(line))
    .join('\n');
}

/**
 * A shade along the logo's pink ramp: t=0 is deep pink, t=0.5 the base,
 * t=1 the glow. Used for the agent-output gutter, whose shade drifts along
 * the ramp as lines stream — a slow shimmer echoing the logo animation.
 * 256-color terminals bucket onto the logo's own fallback codes; no-color
 * output passes through untouched. Closes with default-foreground, not a
 * full reset, so it composes inside other styling.
 */
export function pinkShade(text: string, t: number): string {
  const mode = colorMode();
  if (mode === 'none') return text;
  const clamped = Math.max(0, Math.min(1, t));
  if (mode === '256') {
    const code = clamped < 0.25 ? 125 : clamped < 0.5 ? 204 : clamped < 0.75 ? 211 : 218;
    return `\x1b[38;5;${code}m${text}\x1b[39m`;
  }
  const rgb =
    clamped < 0.5
      ? lerp(DEEP_PINK, BASE_PINK, clamped * 2)
      : lerp(BASE_PINK, GLOW, clamped * 2 - 1);
  return `${fg(rgb)}${text}\x1b[39m`;
}

/** Base color for a row — a subtle deep-to-bright vertical gradient. */
function rowColor(y: number, rows: number): Rgb {
  return lerp(DEEP_PINK, BASE_PINK, y / Math.max(1, rows - 1));
}

/**
 * Render one frame; bandPos = Infinity renders the resting (no shimmer) state.
 * Coloring is per cell: 'W' cells (the mark's upper bars) are white and pulse to
 * pure white as the band crosses; every other cell rides the pink ramp.
 */
function renderFrame(lines: string[], masks: string[], bandPos: number, mode: 'truecolor' | '256'): string {
  return lines
    .map((line, y) => {
      const base = rowColor(y, lines.length);
      const mask = masks[y] ?? '';
      let out = '\x1b[2K';
      let current = '';
      for (let x = 0; x < line.length; x++) {
        const ch = line[x];
        if (ch === ' ') {
          out += ch;
          continue;
        }
        // Diagonal distance from the shimmer band.
        const d = Math.abs(x + y * 0.6 - bandPos);
        const inCore = d < BAND_CORE;
        const inFalloff = d < BAND_CORE + BAND_FALLOFF;
        const white = mask[x] === 'W';
        let code: string;
        if (mode === '256') {
          code = white
            ? '\x1b[38;5;231m'
            : inCore
              ? '\x1b[38;5;218m'
              : inFalloff
                ? '\x1b[38;5;211m'
                : '\x1b[38;5;204m';
        } else {
          const color = white
            ? inCore
              ? ([255, 255, 255] as Rgb)
              : inFalloff
                ? lerp([255, 255, 255], WHITE, (d - BAND_CORE) / BAND_FALLOFF)
                : WHITE
            : inCore
              ? GLOW
              : inFalloff
                ? lerp(GLOW, base, (d - BAND_CORE) / BAND_FALLOFF)
                : base;
          code = fg(color);
        }
        if (code !== current) {
          out += code;
          current = code;
        }
        out += ch;
      }
      return out + RESET;
    })
    .join('\n');
}

function sleep(ms: number): Promise<void> {
  // NB: no unref() — this timer is all that keeps the process alive between
  // animation frames, before the first prompt attaches to stdin.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function showLogo(): Promise<void> {
  const lines = artLines();
  const masks = maskLines();
  const width = Math.max(...lines.map((l) => l.length));
  const columns = process.stdout.columns || 80; // 0/undefined = unknown, assume standard
  if (columns < width) {
    return; // too narrow — wrapping would mangle the art, skip it
  }

  const mode = colorMode();
  if (mode === 'none') {
    process.stdout.write(`${lines.join('\n')}\n\n`);
    return;
  }

  const rows = process.stdout.rows ?? 0;
  const canAnimate = process.stdout.isTTY && rows >= lines.length + 2;
  if (!canAnimate) {
    process.stdout.write(`${renderFrame(lines, masks, Infinity, mode)}\n\n`);
    return;
  }

  const travel = width + lines.length * 0.6 + BAND_CORE + BAND_FALLOFF;
  const frames = 32;
  process.stdout.write('\x1b[?25l'); // hide cursor
  try {
    for (let i = 0; i <= frames; i++) {
      const bandPos = -(BAND_CORE + BAND_FALLOFF) + (travel + BAND_CORE + BAND_FALLOFF) * (i / frames);
      process.stdout.write(renderFrame(lines, masks, i === frames ? Infinity : bandPos, mode));
      process.stdout.write(i === frames ? '\n\n' : `\x1b[${lines.length - 1}A\r`);
      if (i !== frames) await sleep(FRAME_MS);
    }
  } finally {
    process.stdout.write('\x1b[?25h'); // show cursor
  }
}
