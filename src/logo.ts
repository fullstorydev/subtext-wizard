import pc from 'picocolors';

/**
 * The Subtext mark, rendered at startup with a purple shimmer sweep.
 *
 * The animation is cosmetic-only and degrades gracefully: no TTY or no color
 * support prints the art statically; a terminal too small to hold it skips
 * the logo entirely so we never mangle the user's scrollback.
 */

// prettier-ignore
const RAW_ART = [
  '                            |BY',
  '                         ;-C&d@O{i',
  "                      ;1LY;:k'jU^fZfl.",
  "                  .:(dr\"  'k: .vc  .)brl'",
  '                ;|ar      w_   ^Uf     [pX!.',
  '             zwW~        nx^    :J)       "hoI;',
  '             *QBZ       _Ci      !L[       {%Q1',
  "             p! 'idOI  `L]        +L+   c#}\"",
  "             p!    '<X*&z:         ]kaq{\"",
  "             p!     lUW8%a].       'l;.",
  "             p!  '{Q|;  ]L)tZx",
  '             p!;Qz~      >Ol >{Oc^',
  '            lM&).         "p1   :/Yn>',
  '             +;             uv     :)cX~',
  '                             /O       ^1Yu].',
  '                              ia!         )zut|',
  '                               "Q]         ~ukm',
  '                                :Yt     ._0z.xt',
  '                                 `/J^ ;t0~   xt',
  '                      ;-:         .|@@Zi     xt',
  '                   `_Jmb(          )%*b),.   xt',
  "                `<hQ\"  'L[        _Q<   x*(, xt",
  '             u|%U       <Li      i0?       _%@#',
  '             ~CW]        xn"    ;L{       ;oh`\'',
  '                :1*u      Z?.  ^C/     )dnl.',
  "                  .:1wu,  .k: .Xn  '\\btI'",
  "                      :[JLl:h'nz\"n0\\I.",
  '                         :_C&b@O]!',
  '                            [p\\',
];

type Rgb = readonly [number, number, number];

const DEEP_PURPLE: Rgb = [109, 40, 217];
const BASE_PURPLE: Rgb = [155, 100, 250];
const GLOW: Rgb = [231, 213, 255];

const FRAME_MS = 28;
const BAND_CORE = 3; // columns of full glow at the shimmer's center
const BAND_FALLOFF = 8; // columns over which glow fades back to base

/** Art lines with the common left margin removed and a small indent restored. */
function artLines(): string[] {
  const indent = Math.min(...RAW_ART.map((l) => l.length - l.trimStart().length));
  return RAW_ART.map((l) => `  ${l.slice(indent)}`);
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
 * The logo's base purple, for inline text elsewhere in the wizard. 256-color
 * terminals get xterm 99 (the logo's own resting fallback); no-color output
 * passes through untouched. Closes with default-foreground, not a full reset,
 * so it composes inside other styling.
 */
export function brandPurple(text: string): string {
  const mode = colorMode();
  if (mode === 'none') return text;
  const open = mode === '256' ? '\x1b[38;5;99m' : fg(BASE_PURPLE);
  return `${open}${text}\x1b[39m`;
}

/**
 * A shade along the logo's purple ramp: t=0 is deep purple, t=0.5 the base,
 * t=1 the glow. Used for the agent-output gutter, whose shade drifts along
 * the ramp as lines stream — a slow shimmer echoing the logo animation.
 * 256-color terminals bucket onto the logo's own fallback codes; no-color
 * output passes through untouched. Closes with default-foreground, not a
 * full reset, so it composes inside other styling.
 */
export function purpleShade(text: string, t: number): string {
  const mode = colorMode();
  if (mode === 'none') return text;
  const clamped = Math.max(0, Math.min(1, t));
  if (mode === '256') {
    const code = clamped < 0.25 ? 61 : clamped < 0.5 ? 99 : clamped < 0.75 ? 141 : 189;
    return `\x1b[38;5;${code}m${text}\x1b[39m`;
  }
  const rgb =
    clamped < 0.5
      ? lerp(DEEP_PURPLE, BASE_PURPLE, clamped * 2)
      : lerp(BASE_PURPLE, GLOW, clamped * 2 - 1);
  return `${fg(rgb)}${text}\x1b[39m`;
}

/** Base color for a row — a subtle deep-to-bright vertical gradient. */
function rowColor(y: number, rows: number): Rgb {
  return lerp(DEEP_PURPLE, BASE_PURPLE, y / Math.max(1, rows - 1));
}

/** Render one frame; bandPos = Infinity renders the resting (no shimmer) state. */
function renderFrame(lines: string[], bandPos: number, mode: 'truecolor' | '256'): string {
  if (mode === '256') {
    // No per-cell gradient at 256 colors — shimmer the whole rows near the band.
    return lines
      .map((line, y) => {
        const d = Math.abs(y * 2 - bandPos);
        const color = d < BAND_CORE ? '\x1b[38;5;189m' : d < BAND_CORE + BAND_FALLOFF ? '\x1b[38;5;141m' : '\x1b[38;5;99m';
        return `\x1b[2K${color}${line}${RESET}`;
      })
      .join('\n');
  }
  return lines
    .map((line, y) => {
      const base = rowColor(y, lines.length);
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
        const color =
          d < BAND_CORE ? GLOW : d < BAND_CORE + BAND_FALLOFF ? lerp(GLOW, base, (d - BAND_CORE) / BAND_FALLOFF) : base;
        const code = fg(color);
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
    process.stdout.write(`${renderFrame(lines, Infinity, mode)}\n\n`);
    return;
  }

  const travel = width + lines.length * 0.6 + BAND_CORE + BAND_FALLOFF;
  const frames = 32;
  process.stdout.write('\x1b[?25l'); // hide cursor
  try {
    for (let i = 0; i <= frames; i++) {
      const bandPos = -(BAND_CORE + BAND_FALLOFF) + (travel + BAND_CORE + BAND_FALLOFF) * (i / frames);
      process.stdout.write(renderFrame(lines, i === frames ? Infinity : bandPos, mode));
      process.stdout.write(i === frames ? '\n\n' : `\x1b[${lines.length - 1}A\r`);
      if (i !== frames) await sleep(FRAME_MS);
    }
  } finally {
    process.stdout.write('\x1b[?25h'); // show cursor
  }
}
