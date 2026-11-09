---
'@subtextdev/subtext-wizard': minor
---

Add `--headless` for automation: configures the codebase with no prompts (snippet and CSP, then identity, analytics linkage, and privacy masking through a terminal agent if one is installed), writes `.subtext/install-result.json`, and exits 0 when the snippet is installed. `--org` uses the public snippet service without a credential, and `--external-agent` leaves the agent work in `.subtext/agent-prompt.md` for an agent that is already running, for hosted installs.
