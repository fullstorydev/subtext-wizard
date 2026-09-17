# @subtextdev/subtext-wizard

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
