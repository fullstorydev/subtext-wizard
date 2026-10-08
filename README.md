# Subtext setup wizard

<img width="2560" height="658" alt="LOCKUP - HORZ - BY FS - LIGHT - COLOR (3)" src="https://github.com/user-attachments/assets/3f0da600-52c8-4fa1-a203-1918e6a6cfda" />


![NPM Downloads](https://img.shields.io/npm/dm/%40subtextdev%2Fsubtext-wizard?style=flat-square&labelColor=46001f&color=b81b56)
![NPM Last Updated](https://img.shields.io/npm/last-update/%40subtextdev%2Fsubtext-wizard?style=flat-square&labelColor=6b0f36&color=f5447b)
![NPM Version](https://img.shields.io/npm/v/%40subtextdev%2Fsubtext-wizard?style=flat-square&labelColor=9a1847&color=ffd6e4)

**Session replay, built for agents.** Subtext is agentic session review: it captures production sessions of your app and connects them to your coding agent — Claude Code, Cursor, Codex, Devin, your own harness — so it can review what real users did, reproduce reported bugs, verify its own UI changes, and manage capture privacy rules, all without leaving the terminal.



This wizard is the fastest way to set that up. One command, run in your project directory:

```sh
npx @subtextdev/subtext-wizard
```

**Requires a free Subtext account — no credit card.** Subtext is a hosted service that records and stores your app's sessions. Your account is where they live, and where your agent reads them from. When the wizard opens the login page, create an account, then come back to finish.


<p align="center">
  <img width="800" height="565" alt="WIZARD CLI START DEMO" src="https://github.com/user-attachments/assets/dfd32ec4-ba7c-40c9-a6dc-794852530a5b" />
</p>

## What it does


1. **Signs you in** — opens Subtext in your browser to log in or create your free account.
2. **Fetches your capture snippet** — grabs the session-capture snippet for your org.
3. **Installs the snippet directly when it can**: for Next.js, Remix, React Router, Nuxt, SvelteKit, Astro, Gatsby, Angular, Vite, Create React App, Vue CLI, and plain HTML sites, it shows you the exact edit and writes it once you confirm. Anything it can't place with certainty (monorepos, a Content-Security-Policy, unusual layouts) goes to your agent instead.
4. **Asks about your stack** — pick the analytics and product tools you use (PostHog, Amplitude, Mixpanel, Sentry, Segment, and more) so setup can link them up.
5. **Finds your coding agent** — detects Claude Code, Codex, Gemini CLI, Cursor, Windsurf, VS Code, Zed, or Claude Desktop.
6. **Hands the rest to your own agent** — no bundled agent; it drives the one you already use to wire up the capture snippet, MCP server, skills, and commands.

When it finishes, your agent is connected to your sessions. See the [Subtext repo](https://github.com/fullstorydev/subtext) for what it can do from there.

> **What runs on your machine:** the wizard hands the install to your own coding agent and runs it **autonomously** against the target directory — editing files, and (depending on the agent) running commands, with approvals auto-accepted. It also has the agent fetch Subtext's docs. Run it in a project directory you trust, and review the changes (and the reports in `.subtext/`) before you deploy. The wizard asks you to confirm before the agent launches; pass `--yes` only for trusted, non-interactive/CI use.

## Options

```
--dir <path>            App directory to instrument (default: current directory)
--api-key <key>         Skip the browser login and authenticate with a Fullstory
                        API key or OAuth access token (auto-detected)
--api-key-oauth <token> Like --api-key, but always treats the value as an OAuth
                        access token (mutually exclusive with --api-key)
--agent <id>            Skip the agent picker (claude-code, codex, gemini, cursor,
                        windsurf, vscode, zed, claude-desktop, manual)
--integrations <list>   Comma-separated tools to target, skips the picker
--print-prompt          Print the install prompt instead of launching an agent
--headless              No prompts, for automation: configure the codebase only
                        (needs --api-key or SUBTEXT_API_KEY). See below.
--no-telemetry          Opt out of telemetry. Anonymous install telemetry (step
                        progress, outcomes, timings, and agent token usage;
                        never your code or data) is on by default — this flag,
                        or DO_NOT_TRACK=1 / DISABLE_TELEMETRY=1, turns it off
--debug                 Verbose output
--help                  Show all options
```

## Headless mode

`--headless` configures a repo with no human input, for automated setups such as a CI job or a hosted GitHub integration:

```
SUBTEXT_API_KEY=... npx @subtextdev/subtext-wizard --headless --dir path/to/app
```

1. Installs the capture snippet. Recognized frameworks are edited directly; anything else (or a project with a Content-Security-Policy) goes to a terminal coding agent.
2. Runs the extras pass with that agent: user identification, analytics linkage for SDKs found in `package.json` (or `--integrations`), and privacy masking.

It uses `--agent` if given, otherwise the first of Claude Code, Codex CLI, or Gemini CLI on the machine; the agent needs its own credentials (e.g. `ANTHROPIC_API_KEY`). With no agent, only the direct snippet install runs. There's no browser login, plugin setup, demo, or clipboard. The outcome is written to `.subtext/install-result.json`, and the exit code is `0` when the snippet is installed, `1` when it isn't, and `2` when no credential was given.

## Development

Requires Node 18.17+.

```sh
npm install
npm run build             # tsc → dist/
node dist/bin.js --mock   # run the full flow with no network calls
```

<img width="1024" height="705" alt="wizard-hero-light" src="https://github.com/user-attachments/assets/f6fb4cf2-754e-43ad-b8f6-a693ee37ce6a" />
