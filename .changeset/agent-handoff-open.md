---
'@subtextdev/subtext-wizard': minor
---

Offer to open your coding agent at the project folder during the demo hand-off, not just copy the prompt. Terminal harnesses launch a new Terminal.app window `cd`'d into the project (macOS + Terminal.app only); GUI apps reopen at the project folder when they take one, and blank otherwise (Claude Desktop). The demo prompt also now tells the agent to stop and say so if a Subtext tool returns an auth error, which is the usual first-run stumble when the plugin isn't signed in yet.
