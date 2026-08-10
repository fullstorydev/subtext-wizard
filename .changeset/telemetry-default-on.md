---
'@subtextdev/subtext-wizard': minor
---

Collect anonymous install telemetry by default instead of asking for consent after login. On start the wizard now prints a one-line notice explaining what is collected (step progress, outcomes, timings, and agent token usage — never your code or data) and how to opt out. Re-run with `--no-telemetry`, or set the standard `DO_NOT_TRACK=1` / `DISABLE_TELEMETRY=1` env vars, to turn it off; the env-var opt-out is honored silently, with no prompt and no network call.

Also ignore `SUBTEXT_API_KEY` from the environment under `--mock`, so a token left in the shell can't reject or short-circuit the canned mock auth (an explicit `--api-key` is still honored).
