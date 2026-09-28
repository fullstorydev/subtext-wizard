import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clackStub } from './test/helpers.js';

/**
 * The transparency gate: the user reads the exact prompt the agent will run,
 * and proceeding is the authorization. Two things must hold — the prompt is
 * escaped before it reaches a browser, and *choosing to read it* can never
 * abort the run, however the display fails.
 */

const clack = clackStub();
vi.mock('@clack/prompts', () => clack);
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

const open = vi.mocked((await import('open')).default);
const { offerPromptReview, renderPromptHtml, servePromptPage } = await import('./promptReview.js');
const { CancelledError } = await import('./integrations.js');

const PROMPT = 'Install the Subtext capture snippet.\nStep 1: pre-check.';
const CHOICES = { proceedLabel: 'Run the install now with Claude Code' };

function get(url: string): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            type: res.headers['content-type'],
          }),
        );
      })
      .on('error', reject);
  });
}

afterEach(() => vi.resetAllMocks());

// ---------------------------------------------------------------------------

describe('renderPromptHtml', () => {
  it('escapes markup so the prompt cannot become page content', () => {
    const html = renderPromptHtml('<script>alert(1)</script> a & b');

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; a &amp; b');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('escapes the ampersand first, so entities are not double-decoded', () => {
    expect(renderPromptHtml('&lt;')).toContain('&amp;lt;');
  });

  it('keeps the prompt readable as preformatted text', () => {
    const html = renderPromptHtml(PROMPT);
    expect(html).toContain('<pre>');
    expect(html).toContain('Step 1: pre-check.');
  });
});

describe('servePromptPage', () => {
  it('serves the page on / and 404s anything else', async () => {
    const { url, close } = await servePromptPage('<p>hi</p>');
    try {
      const root = await get(url);
      expect(root.status).toBe(200);
      expect(root.type).toMatch(/text\/html/);
      expect(root.body).toBe('<p>hi</p>');

      expect((await get(`${url}secrets`)).status).toBe(404);
    } finally {
      close();
    }
  });

  it('binds loopback only', async () => {
    const { url, close } = await servePromptPage('<p>hi</p>');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    close();
  });

  it('stops serving once closed', async () => {
    const { url, close } = await servePromptPage('<p>hi</p>');
    close();
    await expect(get(url)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('offerPromptReview', () => {
  it('proceeds straight away when the user does not want to read it', async () => {
    clack.confirm.mockResolvedValueOnce(true);

    await expect(offerPromptReview(PROMPT, CHOICES)).resolves.toEqual({ reviewed: false });
    expect(clack.confirm).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it('tells the user how long the prompt is', async () => {
    clack.confirm.mockResolvedValueOnce(true);
    await offerPromptReview(PROMPT, CHOICES);

    expect(String(clack.confirm.mock.calls[0][0].message)).toContain('(2 lines)');
  });

  /**
   * For a terminal run, proceeding here is the only consent gate — there is
   * no second "are you sure". So the autonomy hint has to appear on whichever
   * confirm the user actually answers, including after reading the prompt.
   */
  it('carries the autonomy hint on both confirms', async () => {
    clack.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await offerPromptReview(PROMPT, {
      ...CHOICES,
      proceedHint: 'runs autonomously in /work/app, auto-accepting file edits',
    });

    for (const call of clack.confirm.mock.calls) {
      expect(String(call[0].message)).toContain('runs autonomously in /work/app');
    }
  });

  it('serves and opens the prompt, then confirms again', async () => {
    clack.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(offerPromptReview(PROMPT, CHOICES)).resolves.toEqual({ reviewed: true });

    expect(open).toHaveBeenCalledOnce();
    expect(String(open.mock.calls[0][0])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('serves the actual prompt at that URL', async () => {
    let served: string | undefined;
    clack.confirm.mockResolvedValueOnce(false).mockImplementationOnce(async () => {
      served = (await get(String(open.mock.calls[0][0]))).body;
      return true;
    });

    await offerPromptReview(PROMPT, CHOICES);

    expect(served).toContain('Step 1: pre-check.');
  });

  it('closes the page once the user answers', async () => {
    clack.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await offerPromptReview(PROMPT, CHOICES);

    await expect(get(String(open.mock.calls[0][0]))).rejects.toThrow();
  });

  it('honours the run-wide browser preference by printing the link instead', async () => {
    clack.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await offerPromptReview(PROMPT, { ...CHOICES, openInBrowser: false });

    expect(open).not.toHaveBeenCalled();
    expect(String(clack.log.info.mock.calls[0][0])).toMatch(/127\.0\.0\.1/);
  });

  it('proceeds anyway when the browser will not open', async () => {
    open.mockRejectedValueOnce(new Error('no browser'));
    clack.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(offerPromptReview(PROMPT, CHOICES)).resolves.toEqual({ reviewed: true });
  });

  describe('cancelling', () => {
    it('aborts on Ctrl+C at the first confirm', async () => {
      clack.confirm.mockResolvedValueOnce(clack.cancel$);
      await expect(offerPromptReview(PROMPT, CHOICES)).rejects.toBeInstanceOf(CancelledError);
    });

    it('aborts when the user reads the prompt and then declines', async () => {
      clack.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
      await expect(offerPromptReview(PROMPT, CHOICES)).rejects.toBeInstanceOf(CancelledError);
    });

    it('aborts on Ctrl+C at the second confirm', async () => {
      clack.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(clack.cancel$);
      await expect(offerPromptReview(PROMPT, CHOICES)).rejects.toBeInstanceOf(CancelledError);
    });
  });
});
