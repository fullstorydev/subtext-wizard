import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as p from '@clack/prompts';
import open from 'open';
import pc from 'picocolors';
import { CancelledError } from './integrations.js';

/**
 * Pre-handoff transparency gate: the install prompt is what the coding agent
 * actually executes, so the user gets to read it before anything runs. The
 * prompt is served on a localhost one-shot page (same loopback pattern as the
 * OAuth callback) and opened in the browser; if that fails it lands in a temp
 * file instead. Either way the wizard re-confirms before proceeding.
 */

export interface PromptReviewChoices {
  /** Select-option label and confirm message for proceeding (e.g. "Run the install now with Claude Code"). */
  proceedLabel: string;
  /** Optional hint shown next to the proceed option (e.g. "edits files in /app, auto-accepting"). */
  proceedHint?: string;
}

export async function offerPromptReview(
  prompt: string,
  { proceedLabel, proceedHint }: PromptReviewChoices,
): Promise<{ reviewed: boolean }> {
  const lineCount = prompt.split('\n').length;
  const choice = await p.select({
    message: `The install prompt is ready (${lineCount} lines) — it tells your coding agent exactly what to do.`,
    options: [
      { value: 'proceed', label: proceedLabel, hint: proceedHint },
      { value: 'review', label: 'Review the prompt first', hint: 'opens in your browser' },
      { value: 'cancel', label: 'Cancel' },
    ],
  });
  if (p.isCancel(choice) || choice === 'cancel') {
    throw new CancelledError();
  }
  if (choice === 'proceed') {
    return { reviewed: false };
  }

  let closeServer: (() => void) | undefined;
  try {
    const served = await servePromptPage(renderPromptHtml(prompt));
    closeServer = served.close;
    p.log.info(`Prompt opened at ${pc.cyan(served.url)} — the page stays up until you answer below.`);
    try {
      await open(served.url);
    } catch {
      // URL is printed above; the user can open it manually.
    }
  } catch {
    // No server? Fall back to a temp file the user can open themselves —
    // and if even that fails, print the prompt inline. The user asked to
    // READ the prompt; that must never abort the run.
    try {
      const file = path.join(os.tmpdir(), 'subtext-install-prompt.md');
      await fs.writeFile(file, prompt, 'utf8');
      p.log.info(`Could not open a browser — the prompt is saved at ${pc.cyan(file)}`);
    } catch {
      p.log.warn('Could not open a browser or write a temp file — the prompt is below.');
      console.log(`\n${prompt}\n`);
    }
  }

  const confirmed = await p.confirm({ message: `${proceedLabel}?` });
  closeServer?.();
  if (p.isCancel(confirmed) || !confirmed) {
    throw new CancelledError();
  }
  return { reviewed: true };
}

/** Serves a single HTML page on an ephemeral loopback port. */
export async function servePromptPage(html: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  // unref: the server must never be the thing keeping the process alive —
  // if the wizard exits, the page dies with it.
  server.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderPromptHtml(prompt: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Subtext install prompt</title>
<style>
  body { margin: 0; background: #0f0d15; color: #e7e2f4; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { position: sticky; top: 0; background: #171226; border-bottom: 1px solid #2d2540; padding: 14px 24px; font-family: ui-sans-serif, system-ui, sans-serif; }
  header h1 { margin: 0; font-size: 15px; color: #c4b5fd; }
  header p { margin: 4px 0 0; font-size: 12.5px; color: #8b83a3; }
  main { max-width: 920px; margin: 0 auto; padding: 24px; }
  pre { white-space: pre-wrap; overflow-wrap: break-word; margin: 0; }
</style>
</head>
<body>
<header>
  <h1>subtext &middot; install prompt</h1>
  <p>This is the exact prompt the installer will hand to your coding agent. Return to your terminal to continue or cancel.</p>
</header>
<main><pre>${escapeHtml(prompt)}</pre></main>
</body>
</html>
`;
}
