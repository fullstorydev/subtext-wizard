import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clackStub, makeOptions } from './test/helpers.js';
import type { DetectedAgent } from './agents/types.js';

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);

const agents: DetectedAgent[] = [];
vi.mock('./agents/index.js', () => ({ detectAgents: async () => agents }));

const { runHeadless, INSTALL_RESULT, AGENT_PROMPT } = await import('./headless.js');

const dirs: string[] = [];
afterEach(() => {
  agents.length = 0;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function viteProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtext-headless-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { vite: '5' } }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>\n  <head>\n    <title>x</title>\n  </head>\n</html>\n');
  return dir;
}

const readResult = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, INSTALL_RESULT), 'utf8'));

describe('runHeadless', () => {
  it('refuses to run without a credential', async () => {
    expect(await runHeadless(makeOptions({ headless: true, dir: viteProject() }))).toBe(2);
  });

  it('installs the snippet statically without asking anything, and skips extras with no agent', async () => {
    const dir = viteProject();
    const code = await runHeadless(makeOptions({ headless: true, mock: true, dir }));

    expect(code).toBe(0);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('_fs_org');
    expect(readResult(dir)).toEqual({
      snippet: { status: 'installed', method: 'static', file: 'index.html', framework: 'Vite' },
      extras: { status: 'skipped', reason: 'no coding agent CLI is available' },
      agent: null,
    });
  }, 10_000);

  it('fails with a reason when neither the static install nor an agent can do it', async () => {
    const dir = viteProject();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>no head</body></html>');
    const code = await runHeadless(makeOptions({ headless: true, mock: true, dir }));

    expect(code).toBe(1);
    expect(readResult(dir).snippet).toEqual({
      status: 'failed',
      reason: expect.stringContaining('no coding agent CLI is available'),
    });
  }, 10_000);

  it('--external-agent installs statically and leaves the extras as a prompt file', async () => {
    const dir = viteProject();
    const code = await runHeadless(makeOptions({ headless: true, mock: true, externalAgent: true, dir }));

    expect(code).toBe(0);
    expect(readResult(dir)).toEqual({
      snippet: { status: 'installed', method: 'static', file: 'index.html', framework: 'Vite' },
      extras: { status: 'pending', reason: `see ${AGENT_PROMPT}` },
      agent: 'external',
    });
    const prompt = fs.readFileSync(path.join(dir, AGENT_PROMPT), 'utf8');
    expect(prompt).toContain('# Task: identity, analytics, and privacy');
    expect(prompt).not.toContain('Part 1');
  }, 10_000);

  it('--external-agent hands the snippet install to the agent when it cannot be done statically', async () => {
    const dir = viteProject();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>no head</body></html>');
    const code = await runHeadless(makeOptions({ headless: true, mock: true, externalAgent: true, dir }));

    expect(code).toBe(0);
    expect(readResult(dir).snippet.status).toBe('pending');
    const prompt = fs.readFileSync(path.join(dir, AGENT_PROMPT), 'utf8');
    expect(prompt).toContain('# Part 1: install the capture snippet');
    expect(prompt).toContain('# Part 2: identity, analytics, and privacy');
  }, 10_000);

  it('--org needs no credential', async () => {
    const fetchFn = vi.fn(async () => new Response(`window['_fs_org']='o-ABC-na1';`, { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const dir = viteProject();
    const code = await runHeadless(makeOptions({ headless: true, org: 'o-ABC-na1', externalAgent: true, dir }));

    expect(code).toBe(0);
    expect(new URL(String((fetchFn.mock.calls[0] as unknown[])[0])).searchParams.get('org')).toBe('o-ABC-na1');
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('o-ABC-na1');
  });
});
