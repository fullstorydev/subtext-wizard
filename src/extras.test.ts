import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clackStub } from './test/helpers.js';

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const { readStepResult } = await import('./steps.js');
const { EXTRAS_STEPS, INSTALL_STEPS, buildJoinedPrompt, buildStepPrompt, resultFile } = await import('./prompt/build.js');

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

describe('readStepResult', () => {
  const file = resultFile('identify');
  const result = (body: unknown) => tmp({ [file]: JSON.stringify(body) });

  it('reads a well-formed result', () => {
    const dir = result({ status: 'done', detail: 'setIdentity in app/providers.tsx', files_changed: ['app/providers.tsx'] });
    expect(readStepResult(dir, 'identify')).toEqual({
      status: 'done',
      detail: 'setIdentity in app/providers.tsx',
      filesChanged: ['app/providers.tsx'],
    });
  });

  it('rejects an unknown status and strips terminal escapes from agent text', () => {
    expect(readStepResult(result({ status: 'hacked' }), 'identify')).toBeUndefined();
    const parsed = readStepResult(result({ status: 'done', detail: '\u001b[2Jcleared\nscreen', files_changed: ['a.ts', 42] }), 'identify');
    expect(parsed?.detail).not.toContain('\u001b');
    expect(parsed?.detail).not.toContain('\n');
    expect(parsed?.filesChanged).toEqual(['a.ts']);
  });

  it('keeps long paths whole', () => {
    const long = `src/${'deeply/'.repeat(20)}component.tsx`;
    expect(readStepResult(result({ status: 'done', files_changed: [long] }), 'identify')?.filesChanged).toEqual([long]);
  });

  it('returns undefined for malformed JSON', () => {
    expect(readStepResult(tmp({ [file]: '{ nope' }), 'identify')).toBeUndefined();
  });
});

describe('prompts', () => {
  const none = { integrations: [], other: [] };

  it('a step prompt carries one step and asks for that step\'s result file', () => {
    const prompt = buildStepPrompt('identify', { selection: none });
    expect(prompt).toContain('# Identify users');
    expect(prompt).not.toContain('# Mask sensitive data');
    expect(prompt).toContain(resultFile('identify'));
  });

  it('inserts a snippet containing $ patterns verbatim', () => {
    const snippet = "<script>a.replace(/x$/, \"$&$'\")</script>";
    expect(buildStepPrompt('capture', { snippet })).toContain(snippet);
  });

  it('fills the org snippet into the capture step', () => {
    const prompt = buildStepPrompt('capture', { snippet: '<script>ORG_SNIPPET</script>' });
    expect(prompt).toContain('ORG_SNIPPET');
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('joined interactive prompts have every step and no result file', () => {
    const prompt = buildJoinedPrompt(EXTRAS_STEPS, { selection: none }, 'interactive');
    for (const heading of ['# Identify users', '# Link sessions into existing tools', '# Mask sensitive data']) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).not.toContain('.subtext/results');
  });

  it('no step file links to the next page', () => {
    for (const step of INSTALL_STEPS) {
      const prompt = buildStepPrompt(step, { snippet: '<script></script>' });
      expect(prompt).not.toMatch(/^## Next/m);
      expect(prompt).not.toMatch(/install\/[a-z-]+\.txt/);
    }
  });
});
