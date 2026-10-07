import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clackStub } from './test/helpers.js';

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const { EXTRAS_RESULT, detectAuthLibraries, readExtrasResults } = await import('./extras.js');
const { buildEnrichPrompt } = await import('./prompt/build.js');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtext-extras-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe('detectAuthLibraries', () => {
  it('names auth libraries found in package.json', () => {
    const dir = tmp({ 'package.json': JSON.stringify({ dependencies: { '@clerk/nextjs': '5', next: '15' } }) });
    expect(detectAuthLibraries(dir)).toEqual(['Clerk']);
  });

  it('returns nothing without a package.json', () => {
    expect(detectAuthLibraries(tmp())).toEqual([]);
  });
});

describe('readExtrasResults', () => {
  const result = (body: unknown) => tmp({ [EXTRAS_RESULT]: JSON.stringify(body) });

  it('reads a well-formed result', () => {
    const dir = result({
      identity: { status: 'done', detail: 'setIdentity in app/providers.tsx' },
      analytics: { status: 'skipped', detail: 'no analytics SDK installed' },
      masking: { status: 'done', detail: '4 fields masked' },
      files_changed: ['app/providers.tsx'],
    });
    expect(readExtrasResults(dir, 0)).toEqual({
      identity: { status: 'done', detail: 'setIdentity in app/providers.tsx' },
      analytics: { status: 'skipped', detail: 'no analytics SDK installed' },
      masking: { status: 'done', detail: '4 fields masked' },
      filesChanged: ['app/providers.tsx'],
    });
  });

  it('ignores a result left over from an earlier run', () => {
    const dir = result({ identity: { status: 'done' }, files_changed: [] });
    expect(readExtrasResults(dir, Date.now() + 60_000)).toBeUndefined();
  });

  it('drops invalid fields and strips terminal escapes from agent text', () => {
    const dir = result({
      identity: { status: 'hacked', detail: 'x' },
      masking: { status: 'done', detail: '\u001b[2Jcleared\nscreen' },
      files_changed: ['a.ts', 42],
    });
    const parsed = readExtrasResults(dir, 0);
    expect(parsed?.identity).toBeUndefined();
    expect(parsed?.masking?.detail).not.toContain('\u001b');
    expect(parsed?.masking?.detail).not.toContain('\n');
    expect(parsed?.filesChanged).toEqual(['a.ts']);
  });

  it('returns undefined for malformed JSON', () => {
    expect(readExtrasResults(tmp({ [EXTRAS_RESULT]: '{ nope' }), 0)).toBeUndefined();
  });
});

describe('buildEnrichPrompt scope', () => {
  const none = { integrations: [], other: [] };

  it('narrows identity and analytics when the pre-check found nothing', () => {
    const prompt = buildEnrichPrompt({ selection: none, authLibraries: [], mode: 'headless', telemetry: 'none' });
    expect(prompt).toContain('found no known auth library');
    expect(prompt).toContain('skip Step 5 and record it as skipped');
    expect(prompt).toContain(EXTRAS_RESULT);
    expect(prompt).toContain('Do not mention MCP servers');
  });

  it('points identity at the detected library', () => {
    const prompt = buildEnrichPrompt({ selection: none, authLibraries: ['Clerk'], mode: 'headless', telemetry: 'none' });
    expect(prompt).toContain('found Clerk in `package.json`');
  });

  it('only asks for the result file in headless runs', () => {
    const prompt = buildEnrichPrompt({ selection: none, authLibraries: [], mode: 'interactive', telemetry: 'none' });
    expect(prompt).not.toContain(EXTRAS_RESULT);
  });
});
