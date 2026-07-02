# @subtext/install

One-command onboarding for Subtext session capture:

```sh
npx @subtext/install
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

Two layers, both fire-and-forget and disabled by `--no-telemetry`:

- **CLI events** (`src/telemetry.ts`) — `wizard_started`, `auth_completed`, `integrations_selected`, `agents_detected`, `agent_launch_started`, `wizard_completed`, `wizard_error`, correlated by a per-run `run_id`.
- **Agent-side checkpoints** — the prompt itself instructs the agent to `curl` a background ping after each install step, tagged with the same `run_id`, so progress is visible even during the agent-led portion.

## Endpoints

Auth and snippet use **real production endpoints** (audited against the `mn` monorepo — see `docs/notion-wizard-plan.md` for the full audit):

- `https://auth.fullstory.com/oauth/{register,authorize,token}` — OAuth 2.1, PKCE public client, loopback redirect
- `https://api.fullstory.com/code/v2/snippet?org=…&type=CORE` — public org snippet (`api.eu1.…` for EU orgs)
- `https://telemetry.subtext.fullstory.com/v1/wizard-events` — **PLACEHOLDER**, no backend yet

Overridable via env vars (`SUBTEXT_AUTH_BASE_URL`, `SUBTEXT_API_BASE_URL`, `SUBTEXT_TELEMETRY_URL`, `SUBTEXT_OAUTH_CLIENT_ID`, `SUBTEXT_OAUTH_SCOPES`). Use `--mock` to run the whole flow offline with canned auth and the example snippet. Remaining backend work (pre-registered OAuth client, scope decision, telemetry ingest, org-aware snippet for custom-host orgs) is itemized in `docs/notion-wizard-plan.md`.

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
docs/notion-wizard-plan.md    Endpoint audit + backend build plan
src/bin.ts                    CLI entry + arg parsing
src/run.ts                    Wizard orchestration
src/auth.ts                   OAuth PKCE + loopback browser login
src/snippet.ts                Org snippet fetch (public snippet service)
src/integrations.ts           Integration catalog + multiselect
src/prompt/build.ts           Prompt assembly (headless vs interactive variants)
src/agents/                   Agent detection + launch strategies
src/telemetry.ts              Fire-and-forget event reporting
```
