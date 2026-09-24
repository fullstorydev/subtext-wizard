---
'@subtextdev/subtext-wizard': minor
---

Pre-detect analytics tools from the app's `package.json` (dependencies + devDependencies) instead of opening on a blank 15-item picker. When something is found, the wizard confirms it and keeps the full catalog behind a single "any others?" question; when nothing is found the picker behaves as before. Detection only steers the prompt — the agent still detects SDKs itself during the install, so script-tag and CDN installs are caught then.
