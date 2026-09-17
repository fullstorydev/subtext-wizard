---
"@subtextdev/subtext-wizard": minor
---

Accept a normal Fullstory API key for `--api-key` / `SUBTEXT_API_KEY`, not just an OAuth access token. The value is now auto-detected: an OAuth token resolves its org locally from the JWT, while a plain API key is validated against `GET /me` (sent as `Authorization: Basic <key>`) to resolve the org id, seat email, and data realm. The credential's scheme (Bearer for OAuth, Basic for API keys) carries through to telemetry so every authenticated call uses the right header.

Added `--api-key-oauth` / `SUBTEXT_API_KEY_OAUTH` for callers who want to force the OAuth-token path explicitly (the wizard's original `--api-key` behavior). It is mutually exclusive with `--api-key`.
