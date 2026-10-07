---
'@subtextdev/subtext-wizard': minor
---

The optional extras (identify users, link analytics, mask PII) now run a package.json pre-check that scopes the agent run, ask for consent right before the agent starts, and end on a wizard-written results summary instead of raw agent output. Agent reports move to `.subtext/`. Terminal output is quieter: one sign-in line, a spinner for Claude Code progress (no MCP servers loaded, stderr held back unless the run fails), a shorter snippet preview, a "Next steps" box, a framed demo prompt, and an outro that matches what happened. The analytics picker only offers SDKs found in package.json.
