# @subtextdev/subtext-wizard

One-command onboarding for Subtext session capture:

```sh
npx @subtextdev/subtext-wizard
```

Previously users copied a long setup prompt into their coding agent by hand. This CLI replaces that: it authenticates the user, fetches their org-specific capture snippet, asks which analytics tools to integrate with, then hands the install to **the user's own coding agent** — we never bundle or provide one.

## What it does

1. **Login** — real OAuth 2.1 against production `auth.fullstory.com` (heimdall): dynamic client registration (RFC 7591), authorization-code + PKCE, loopback redirect on `127.0.0.1`. The access-token JWT carries `org_id` and the user's email, so no extra lookup is needed.
2. **Snippet fetch** — calls the public snippet service (`GET api.fullstory.com/code/v2/snippet?org=…&type=CORE`) with realm-aware hosts and wraps the result in a `<script>` tag.
3. **Integration selection** — multiselect of PostHog, Amplitude, Mixpanel, Statsig, Sentry, LogRocket, Datadog, LaunchDarkly, GrowthBook, Intercom, Pendo, Appcues, Userpilot, Sprig, Segment, plus free-text "Other". The choices tailor the detection and linkage steps of the install prompt.
4. **Agent detection** — finds coding agents installed on the machine and asks which to use.
5. **Handoff** — assembles the install prompt and runs it on the chosen agent:

| Agent | Kind | Behavior |
|---|---|---|
| Claude Code | terminal | Runs headless in the same terminal (`claude -p`, prompt on stdin, `--permission-mode acceptEdits`, streamed `stream-json` progress) |
| Codex CLI | terminal | Runs headless (`codex exec --full-auto`) |
| Gemini CLI | terminal | Runs headless (`gemini --yolo -p`) |
| Cursor / Windsurf / VS Code / Zed | app | Copies the prompt to the clipboard, opens the app at the project folder, shows paste instructions |
| Claude Desktop | app | Copies the prompt, opens the app, shows paste instructions |
| None detected | — | Copies the prompt to the clipboard / prints it |

Terminal agents get the **headless** prompt variant (approval gates replaced with "use best judgment + write `subtext-setup-report.md`"). App handoffs get the **interactive** variant, which keeps every plan/identity/privacy approval gate from the original onboarding prompt.

## Telemetry

Consent-gated and fire-and-forget: after login the wizard asks whether it may collect telemetry about the install session (step progress, outcomes, and timings — never code or data). Declining, or passing `--no-telemetry`, disables everything below. Events are `WorkflowEvent` payloads (workflow `onboard`) POSTed to `/subtext/telemetry`, authenticated with the user's OAuth access token.

Two layers:

- **CLI events** (`src/telemetry.ts`) — a `start` event when a terminal or manual run reaches handoff (harness, time-to-handoff), a `complete` outcome when a terminal agent exits (`success` requires the agent's own install-step marker, not just exit code 0), and a `fail`/`skipped` outcome if the run errors or is cancelled.
- **Agent-side checkpoints** — the prompt instructs the agent to report each install step as it finishes; `analytics_providers` reflects what the agent actually detects, not the user's picker selection. Two variants:
  - *Terminal runs* never see a credential — the token would leak to every install subprocess (npm postinstall scripts etc.). Instead the agent **prints** one `__SUBTEXT_TELEMETRY__ {…}` marker line per step (`precheck` → `mask_pii`); the wizard parses these out of the agent's stdout (`src/agents/telemetry-marker.ts`, with a step/metadata allowlist and one-event-per-step cap) and sends the events itself with the token it holds in-process.
  - *GUI handoffs* log through the Subtext plugin's `telemetry-event` MCP tool — the wizard walks the user through installing the plugin (fullstorydev/subtext) before opening the app — and the agent logs its own `start` event with harness/model.
  - *Manual handoffs* (and `--print-prompt` output) get no checkpoints: there's no wizard attached to parse markers and no known agent to hold the plugin.

## Endpoints

Auth, snippet, and telemetry use **real production endpoints**:

- `https://auth.fullstory.com/oauth/{register,authorize,token}` — OAuth 2.1, PKCE public client, loopback redirect
- `https://api.fullstory.com/code/v2/snippet?org=…&type=CORE` — public org snippet (`api.eu1.…` for EU orgs)
- `https://api.fullstory.com/subtext/telemetry` — workflow-event ingest (Bearer auth, realm-aware)

Overridable via env vars (`SUBTEXT_AUTH_BASE_URL`, `SUBTEXT_API_BASE_URL`, `SUBTEXT_TELEMETRY_URL`, `SUBTEXT_OAUTH_CLIENT_ID`, `SUBTEXT_OAUTH_SCOPES`). Use `--mock` to run the whole flow offline with canned auth and the example snippet. Remaining backend work: pre-registered OAuth client, scope decision, org-aware snippet for custom-host orgs.

## Flags

```
--dir <path>            App directory to instrument (default: cwd)
--region <us|eu>        Data region for login and API hosts (default: us)
--api-key <key>         Skip browser login (OAuth access tokens only)
--agent <id>            Skip the agent picker (claude-code, codex, gemini, cursor,
                        windsurf, vscode, zed, claude-desktop, manual)
--integrations <list>   Skip the multiselect (unknown names become "Other")
--print-prompt          Print the assembled prompt instead of launching
--mock                  No network calls
--no-telemetry          Disable telemetry
--debug                 Verbose output
```

Example end-to-end dry run:

```sh
node dist/bin.js --mock --print-prompt --integrations "posthog,sentry" --agent claude-code
```

## Development

```sh
npm install
npm run build      # tsc → dist/
node dist/bin.js --mock
```

Layout:

```
templates/install-prompt.md   The onboarding prompt, with {{PLACEHOLDER}} slots
templates/mock-snippet.html   Example snippet returned in --mock mode
src/bin.ts                    CLI entry + arg parsing
src/run.ts                    Wizard orchestration
src/auth.ts                   OAuth PKCE + loopback browser login
src/snippet.ts                Org snippet fetch (public snippet service)
src/integrations.ts           Integration catalog + multiselect
src/prompt/build.ts           Prompt assembly (headless vs interactive variants)
src/agents/                   Agent detection + launch strategies
src/telemetry.ts              Fire-and-forget event reporting
```
