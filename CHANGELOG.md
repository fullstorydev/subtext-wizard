# @subtextdev/subtext-wizard

## 0.4.0

### Minor Changes

- 1daef31: Offer to open your coding agent at the project folder during the demo hand-off, not just copy the prompt. Terminal harnesses launch a new Terminal.app window `cd`'d into the project (macOS + Terminal.app only); GUI apps reopen at the project folder when they take one, and blank otherwise (Claude Desktop). The demo prompt also now tells the agent to stop and say so if a Subtext tool returns an auth error, which is the usual first-run stumble when the plugin isn't signed in yet.
- 23604a5: Pre-detect analytics tools from the app's `package.json` (dependencies + devDependencies) instead of opening on a blank 15-item picker. When something is found, the wizard confirms it and keeps the full catalog behind a single "any others?" question; when nothing is found the picker behaves as before. Detection only steers the prompt — the agent still detects SDKs itself during the install, so script-tag and CDN installs are caught then.
- 1fae491: Split setup into two phases to reach a first agentic session review faster. The first hand-off now installs the capture snippet (and CSP) only — precheck, explore, plan, install — so the user can restart their dev server, capture a session, and review it right away. Afterward the wizard offers the enrichment step (user identification, analytics linkage, and PII masking); for terminal agents this is a second driven run in the same session, and for app/manual hand-offs it's a copyable follow-up prompt. The analytics-integration picker has moved out of the up-front flow into this enrichment step, where it's actually used. Each phase is now labeled ("Step 1 of 2", "Step 2 of 2") and gated by a single prompt: the pre-handoff prompt review carries the autonomy consent for terminal agents (no separate "run autonomously?" confirm), and the enrichment opt-in stands on its own (no second prompt review). The session-review-tools (plugin/MCP) consent for terminal agents is now asked up front alongside the handoff rather than mid-flow, so the post-install first-run guide isn't interrupted — the setup itself still runs after the install. The opening banner and telemetry notice are trimmed to a line each. `--print-prompt` is now a dry run that prints each phase's prompt as it's built and continues the flow without launching the agent, instead of printing one prompt and exiting. The install telemetry funnel is unchanged — one `start`/`complete` spanning both phases, each step reported exactly once.

### Patch Changes

- df71360: Replace the three-option pre-handoff prompt review with a Yes / "review first" confirm (Ctrl+C cancels), and carry the autonomy hint onto the post-review confirm so choosing to read the prompt first doesn't drop the wording about what the run auto-approves.
- 7c21519: Render the plugin-setup notes at full strength instead of clack's dimmed default, via a shared `readableNoteBody` helper.

## 0.3.0

### Minor Changes

- 604f719: Accept a normal Fullstory API key for `--api-key` / `SUBTEXT_API_KEY`, not just an OAuth access token. The value is now auto-detected: an OAuth token resolves its org locally from the JWT, while a plain API key is validated against `GET /me` (sent as `Authorization: Basic <key>`) to resolve the org id, seat email, and data realm. The credential's scheme (Bearer for OAuth, Basic for API keys) carries through to telemetry so every authenticated call uses the right header.

  Added `--api-key-oauth` / `SUBTEXT_API_KEY_OAUTH` for callers who want to force the OAuth-token path explicitly (the wizard's original `--api-key` behavior). It is mutually exclusive with `--api-key`.

- bd1826f: Update eu wiring to be handled manually instead of via plugin

### Patch Changes

- a215396: Apply `npm audit fix`: bump the dev-dependency `js-yaml` to 4.3.2 and its nested 3.15.2 copy to pick up the security patches.

## 0.2.1

### Patch Changes

- 44054dc: The startup logo now shows the subtext avatar — rasterized from the brand-pack
  SVG into a braille dot matrix — beside the SUBTEXT wordmark. The two upper bars
  render white while the down-left accent bar and the wordmark carry the brand
  pink, all under the existing shimmer sweep.

## 0.2.0

### Minor Changes

- e65b4c6: Collect anonymous install telemetry by default instead of asking for consent after login. On start the wizard now prints a one-line notice explaining what is collected (step progress, outcomes, timings, and agent token usage — never your code or data) and how to opt out. Re-run with `--no-telemetry`, or set the standard `DO_NOT_TRACK=1` / `DISABLE_TELEMETRY=1` env vars, to turn it off; the env-var opt-out is honored silently, with no prompt and no network call.

  Also ignore `SUBTEXT_API_KEY` from the environment under `--mock`, so a token left in the shell can't reject or short-circuit the canned mock auth (an explicit `--api-key` is still honored).

## 0.1.8

### Patch Changes

- a1a684d: New startup logo art, and the brand accent is now pink (#F5447B): the logo
  shimmer, the agent-output gutter bar, and inline accent text all use the new
  pink ramp in place of the old purple.

## 0.1.7

### Patch Changes

- fc073a0: Adopt changesets for automated releases. No functional changes to the CLI; this release validates the new publish pipeline.
