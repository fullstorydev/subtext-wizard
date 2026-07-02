# Subtext Install Wizard — Endpoint Audit & Build Plan

> Target page: https://app.notion.com/p/wizard-391f4b241a5e80a9874ceed3be04911b
> Audited against the `mn` monorepo + live production endpoints on 2026-07-02.

## Summary

The npx install wizard (`@subtext/install`) needs three backend capabilities: **user auth**, **org-specific snippet fetch**, and **telemetry ingest**. Two of the three already exist in production and the wizard now uses them. Telemetry has no home yet, and there are four hardening items before GA.

| Capability | Status | What the wizard uses |
|---|---|---|
| Auth | ✅ exists, wired up | OAuth 2.1 PKCE + loopback via `auth.fullstory.com` (heimdall) |
| Org snippet | ✅ exists, wired up (with caveat) | Public `GET /code/v2/snippet?org=…&type=CORE` on `api.fullstory.com` |
| Telemetry | ❌ missing | Placeholder `POST telemetry.subtext.fullstory.com/v1/wizard-events` |

## What exists today (verified)

### 1. OAuth — heimdall (`fs/services/heimdall`)

Live at `https://auth.fullstory.com` (discovery: `/.well-known/oauth-authorization-server`):

- `POST /oauth/register` — RFC 7591 dynamic client registration, open + rate-limited (`FS_OAUTH_CLIENT_REGISTRATION_LIMIT_BURST=20`, hourly 100). Verified live: registers a public client with `token_endpoint_auth_method: none`.
- `GET /oauth/authorize` — authorization code + PKCE S256 (mandatory for public clients).
- `POST /oauth/token` — public clients supported (`token_endpoint_auth_methods_supported: ["none"]`), refresh tokens issued.
- Loopback redirects (`http://127.0.0.1:<any-port>/callback`) allowed per RFC 8252 — `internal/oauth/uri_validation.go`.
- Access token format `<realm>.oauth!<JWT>`; JWT claims include `org_id` and `sub` (user email) — `internal/claims/oauth_token.go`. **No "who am I" endpoint needed**: the wizard decodes the payload locally. Access tokens expire in 10 minutes (fine for a wizard run; refresh token available).
- This is the same server the Subtext MCP resource uses (`https://api.fullstory.com/.well-known/oauth-protected-resource/mcp/subtext` → `authorization_servers: ["https://auth.fullstory.com"]`), so the flow is already proven by Claude Code / Cursor MCP OAuth.

### 2. Org snippet — snippet service (`fs/services/snippet`)

Public, unauthenticated, verified live:

```
GET https://api.fullstory.com/code/v2/snippet?org=<orgId>&type=CORE&host=<host>&script=<script>&namespace=FS
```

- `type=CORE` returns the full inline snippet body (`window['_fs_*']` assignments + IIFE) — exactly what goes inside a `<script>` tag. (`type` defaults to ESM; `RAW` omits the window assignments.)
- Routes registered in `fs/services/snippet/main/snippet/snippet.go` (`/code/v1|v2|v2.1/snippet`, `/d/snippet/v*.js` for CDN).
- Realm handling: org ids encode the realm (`-eu1` suffix; `fs/services/orgs/entity/entityid.go`). The wizard derives region from the token/org id and passes eu1 hosts (`eu1.fullstory.com`, `edge.eu1.fullstory.com/s/fs.js`) for EU orgs.

### 3. Telemetry — nothing suitable

- `POST api.fullstory.com/v2/events` exists but requires an org API key and writes into the *customer's* event stream — wrong place for installer telemetry.
- Internal analytics (`fs/internaldata/analytics`) is Pub/Sub → BigQuery (`event-logger` topic), not exposed over HTTP.
- No wizard/onboarding progress endpoint exists.

## Gaps to close (the plan)

### P0 — needed before GA

1. **Pre-registered first-party OAuth client.**
   Today the wizard dynamically registers a fresh client per run. Works, but pollutes the client table and hits the registration rate limit at scale. Register one first-party public client (heimdall `OAuthPublic.CreateApplication`), name it "Subtext Install", redirect URI `http://127.0.0.1/callback`, grants `authorization_code`+`refresh_token`, and bake the `client_id` into the wizard (`SUBTEXT_OAUTH_CLIENT_ID`). Keep dynamic registration as fallback.

2. **Decide the minimal OAuth scope.**
   The install itself needs no data API — the wizard currently requests `sessions:read` just to have a valid, seat-checkable scope on the consent screen. Options: (a) keep `sessions:read`; (b) add a purpose-built no-op scope like `org:install` so the consent screen reads honestly; (c) confirm empty-scope authorize works and request nothing. Needs a heimdall owner's call.

3. **Telemetry ingest endpoint.**
   Build `POST /v1/wizard-events` (host TBD — `api.subtext.fullstory.com` or edge). Unauthenticated, fire-and-forget, rate-limited by IP + `run_id`, body = the payload already emitted by `src/telemetry.ts` (`{event, run_id, timestamp, properties}`). Backend: publish to a Pub/Sub topic → BigQuery, mirroring `fs/internaldata/analytics`. This also serves the agent-side step checkpoints the install prompt fires via background `curl`.

### P1 — correctness / polish

4. **Authenticated org-aware snippet endpoint.**
   The public snippet endpoint bakes in *default* hosts. Orgs with custom script hosts / first-party relays get the wrong snippet (the correct one is what webber embeds in the UI bootstrap via `recording.SnippetWithScriptTags()` — `fs/services/webber/internal/ui/handlers.go`). Add an authenticated `GET /v1/orgs/self/snippet` (or a Subtext MCP tool) that returns the org-configured snippet + the CSP host list. Until then the wizard is correct for standard orgs only.

5. **API-key path.**
   `--api-key` currently only accepts OAuth access tokens (the wizard reads `org_id` from the JWT). Opaque org API keys have no public "resolve my org" endpoint. Either document OAuth-token-only, or add token introspection / a `GET /v2/me`-style endpoint.

6. **Verify EU auth host.**
   The wizard assumes `auth.eu1.fullstory.com` mirrors heimdall (registration + authorize + token). Verify and confirm EU consent flow; `--region eu` flag is already in place.

### P2 — later

7. **CI / headless-shell auth** — device authorization grant (RFC 8628). A helper exists (`fs/shared/util/deviceflow/df.go`) but is not integrated into heimdall's token endpoint. Only needed for SSH/CI environments where a loopback browser flow can't run.
8. **Refresh-token use** — the wizard finishes well inside the 10-minute access-token lifetime today; if later steps (privacy rules, session verification) get added, use the stored refresh token.

## Wizard-side state (already done)

- `src/auth.ts` — full PKCE + loopback + dynamic-registration flow against production heimdall; JWT claim decoding for `org_id`/email/realm.
- `src/snippet.ts` — live fetch from `/code/v2/snippet?type=CORE`, realm-aware hosts, wrapped in `<script>`.
- `src/config.ts` — real endpoints; only `TELEMETRY_ENDPOINT` remains a placeholder.
- `--region us|eu`, `--mock` (offline flow), `--api-key` (OAuth tokens only).

## Open questions

- Which team owns heimdall client pre-registration + scope additions?
- Where should wizard telemetry land (BQ dataset, retention, dashboards)?
- Should the snippet returned to the wizard be Subtext-branded/versioned differently from the Fullstory UI snippet?
