import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The logo is cosmetic, so the only thing worth testing is that it degrades
 * instead of mangling someone's terminal: no colour support passes text
 * through untouched, and a window too narrow for the art skips it entirely
 * rather than wrapping it into noise.
 */

const pc = vi.hoisted(() => ({
  isColorSupported: true,
  dim: (s: string) => s,
  reset: (s: string) => `[reset]${s}`,
}));
vi.mock('picocolors', () => ({ default: pc }));

const { brandPink, pinkShade, readableNoteBody, showLogo } = await import('./logo.js');

const ESC = String.fromCharCode(0x1b);

let stdout: string[];
let realDescriptors: Record<string, PropertyDescriptor>;

beforeEach(() => {
  pc.isColorSupported = true;
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  realDescriptors = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns')!,
    rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows')!,
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')!,
  };
});

afterEach(() => {
  for (const [key, descriptor] of Object.entries(realDescriptors)) {
    if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function terminal({ columns = 120, rows = 40, isTTY = false }) {
  for (const [key, value] of Object.entries({ columns, rows, isTTY })) {
    Object.defineProperty(process.stdout, key, { value, configurable: true });
  }
}

const written = () => stdout.join('');

// ---------------------------------------------------------------------------

describe('brandPink', () => {
  it('passes text through untouched without colour support', () => {
    pc.isColorSupported = false;
    expect(brandPink('SUBTEXT')).toBe('SUBTEXT');
  });

  it('uses truecolor when the terminal advertises it', () => {
    vi.stubEnv('COLORTERM', 'truecolor');
    expect(brandPink('x')).toBe(`${ESC}[38;2;245;68;123mx${ESC}[39m`);
  });

  it('falls back to a 256-colour code otherwise', () => {
    vi.stubEnv('COLORTERM', '');
    expect(brandPink('x')).toBe(`${ESC}[38;5;204mx${ESC}[39m`);
  });

  // Closing with default-foreground rather than a full reset lets this
  // compose inside other styling.
  it('closes the colour without resetting everything', () => {
    vi.stubEnv('COLORTERM', 'truecolor');
    expect(brandPink('x').endsWith(`${ESC}[39m`)).toBe(true);
    expect(brandPink('x')).not.toContain(`${ESC}[0m`);
  });
});

describe('pinkShade', () => {
  it('passes text through untouched without colour support', () => {
    pc.isColorSupported = false;
    expect(pinkShade('|', 0.5)).toBe('|');
  });

  it('buckets onto four fixed codes in 256-colour mode', () => {
    vi.stubEnv('COLORTERM', '');
    const codes = [0, 0.3, 0.6, 0.9].map((t) => pinkShade('|', t));
    expect(new Set(codes).size).toBe(4);
    expect(codes[0]).toContain('38;5;125');
    expect(codes[3]).toContain('38;5;218');
  });

  it('walks deep pink to glow through the base in truecolor', () => {
    vi.stubEnv('COLORTERM', 'truecolor');
    expect(pinkShade('|', 0)).toContain('38;2;184;27;86');
    expect(pinkShade('|', 0.5)).toContain('38;2;245;68;123');
    expect(pinkShade('|', 1)).toContain('38;2;255;216;230');
  });

  it('clamps out-of-range positions to the ends of the ramp', () => {
    vi.stubEnv('COLORTERM', 'truecolor');
    expect(pinkShade('|', -5)).toBe(pinkShade('|', 0));
    expect(pinkShade('|', 5)).toBe(pinkShade('|', 1));
  });
});

describe('readableNoteBody', () => {
  it('resets each line so clack’s note dimming does not apply', () => {
    expect(readableNoteBody('one\ntwo')).toBe('[reset]one\n[reset]two');
  });

  it('keeps blank lines', () => {
    expect(readableNoteBody('a\n\nb').split('\n')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------

describe('showLogo', () => {
  it('prints nothing when the window is narrower than the art', async () => {
    terminal({ columns: 40 });
    await showLogo();
    expect(written()).toBe('');
  });

  // `process.stdout.columns` is undefined when piped; assume a standard width
  // rather than suppressing the logo for every non-tty run.
  it('assumes 80 columns when the width is unknown', async () => {
    terminal({ columns: 0 });
    pc.isColorSupported = false;
    await showLogo();
    expect(written()).not.toBe('');
  });

  it('prints plain art with no escape codes when colour is unsupported', async () => {
    terminal({ columns: 120 });
    pc.isColorSupported = false;

    await showLogo();

    expect(written()).not.toContain(ESC);
    expect(written().endsWith('\n\n')).toBe(true);
  });

  it('renders a single static frame when stdout is not a TTY', async () => {
    terminal({ columns: 120, isTTY: false });
    vi.stubEnv('COLORTERM', 'truecolor');

    await showLogo();

    expect(written()).toContain(ESC);
    // No cursor hiding and no reposition — that would be animation.
    expect(written()).not.toContain(`${ESC}[?25l`);
    expect(written()).not.toContain('A\r');
  });

  it('renders statically when the window is too short to animate', async () => {
    terminal({ columns: 120, rows: 4, isTTY: true });
    vi.stubEnv('COLORTERM', 'truecolor');

    await showLogo();

    expect(written()).not.toContain(`${ESC}[?25l`);
  });

  it('animates on a tall enough TTY, and always restores the cursor', async () => {
    terminal({ columns: 120, rows: 40, isTTY: true });
    vi.stubEnv('COLORTERM', 'truecolor');

    await showLogo();

    expect(written()).toContain(`${ESC}[?25l`);
    expect(written().endsWith(`${ESC}[?25h`)).toBe(true);
  }, 10_000);
});
