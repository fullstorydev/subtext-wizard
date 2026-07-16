# Subtext setup wizard

**Session replay, built for agents.** [Subtext](https://github.com/fullstorydev/subtext) is agentic session review: it captures production sessions of your app and connects them to your coding agent, so it can review what real users did, reproduce reported bugs, and verify its own UI changes.

This wizard is the fastest way to set that up. One command, run in your project directory:

```sh
npx @subtextdev/subtext-wizard
```

**Requires a free Subtext account — no credit card.** Subtext is a hosted service that records and stores your app's sessions. Your account is where they live, and where your agent reads them from. When the wizard opens the login page, create an account in one click with Google, then come back to finish.

## What it does

1. **Signs you in** — opens Subtext in your browser to log in or create your free account.
2. **Fetches your capture snippet** — grabs the session-capture snippet for your org.
3. **Asks about your stack** — pick the analytics and product tools you use (PostHog, Amplitude, Mixpanel, Sentry, Segment, and more) so setup can link them up.
4. **Finds your coding agent** — detects Claude Code, Codex, Gemini CLI, Cursor, Windsurf, VS Code, Zed, or Claude Desktop.
5. **Hands the install to your own agent** — no bundled agent; it drives the one you already use to wire up the capture snippet, MCP server, skills, and commands.

When it finishes, your agent is connected to your sessions. See the [Subtext repo](https://github.com/fullstorydev/subtext) for what it can do from there.

## Options

```
--dir <path>            App directory to instrument (default: current directory)
--api-key <key>         Skip the browser login and use this access token
--agent <id>            Skip the agent picker (claude-code, codex, gemini, cursor,
                        windsurf, vscode, zed, claude-desktop, manual)
--integrations <list>   Comma-separated tools to target, skips the picker
--print-prompt          Print the install prompt instead of launching an agent
--no-telemetry          Disable usage telemetry (otherwise the wizard asks for
                        consent after login; never collects code or data)
--debug                 Verbose output
--help                  Show all options
```

## Development

Requires Node 18.17+.

```sh
npm install
npm run build             # tsc → dist/
node dist/bin.js --mock   # run the full flow with no network calls
```
