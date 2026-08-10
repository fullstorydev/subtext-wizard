## Step 1: Pre-check

Determine whether the capture snippet is *actually* installed. The snippet is the code that loads and initializes session capture — not helper utilities, type declarations, or UI text that mentions "Fullstory."

Run these checks in order. Stop at the first positive match.

1. Package dependencies (highest confidence) — Read `package.json`. Look for `@fullstory/browser`, `@fullstory/react-native`, `@fullstory/snippet`, or `@subtextdev/hydrogen` in `dependencies` or `devDependencies`.
2. Script tag in HTML entry point — Search ONLY the HTML entry point (`index.html`, `app/layout.tsx`, `pages/_document.tsx`, or framework equivalent) for the literal strings `fullstory.com/s/fs.js` or `_fs_script`. Do not search other files.
3. SDK initialization call — Grep for `init\(\s*\{\s*orgId`, `window\['_fs_org'\]\s*=`, or `window\._fs_org\s*=` in `.ts`, `.tsx`, `.js`, `.jsx` files (exclude `node_modules`, test files, and `*.d.ts`). The `init()` call comes from `@fullstory/browser` v2: `import { init } from '@fullstory/browser'`.

These are NOT the snippet and MUST be ignored:

- `https://subtext.fullstory.com`, `https://www.fullstory.com` — URLs in copy or config. Ignore.
- Footer text, marketing copy mentioning "Fullstory" — UI text. Ignore.
- `declare global { interface Window { FS?: ... } }` — Type declarations. Ignore.
- `window.FS(...)` helpers in `/lib/`, `/utils/` — Consumers of the snippet. Ignore.
- `addEventListener('fullstory:dataLayerChange', ...)` — Event listeners. Ignore.
- `import { waitForSession } from '@/lib/fullstory'` — Wrapper modules. Ignore.

Do NOT broad-grep for "fullstory" or "Fullstory" — it produces false positives. Only search for the exact patterns above.

If a genuine snippet is found, report "Subtext snippet already installed at {file}:{line}" and stop.

## Step 2: Explore the codebase

Before making any changes, do a read-only pass to gather what the install will depend on. Only use data that is already available on the client — do NOT add server calls, API fetches, or new data loading to support Subtext. Work with what the app already has.

### Framework

Read `package.json` and project structure to detect the framework:

- `@shopify/hydrogen` in dependencies → Shopify Hydrogen → wrapper-package install, see "Shopify Hydrogen" under Framework patterns. Check this FIRST: Hydrogen apps also contain Remix/React Router and Vite dependencies, which must not shadow this match.
- `next` in dependencies → Next.js (App Router) → `app/layout.tsx`
- `next` + `pages/_document.tsx` exists → Next.js (Pages Router) → `pages/_document.tsx`
- `@remix-run/*` in dependencies → Remix → `app/root.tsx`
- `vite` in devDependencies → Vite → `index.html`
- `react-scripts` in dependencies → Create React App → `public/index.html`
- `react-native` in dependencies → React Native → App entry point
- None of the above → Plain HTML → `index.html` (search for `<head>` if missing)

If nothing matches and no `index.html` exists, search `.html`, `.tsx`, `.jsx` files for `<head>` tags, present the candidates, and ask me which file to use.

### Content Security Policy

Search for any `Content-Security-Policy` header set in middleware, server config, framework config (e.g. `next.config.js`, `vercel.json`, `netlify.toml`), or a `<meta http-equiv="Content-Security-Policy">` tag in HTML. If one exists, note the directive changes that will be needed:

- `script-src` — add `https://edge.fullstory.com` and `https://rs.fullstory.com`. The snippet runs an inline bootstrap, so `'unsafe-inline'` or a nonce on the snippet `<script>` is also required.
- `connect-src` — add `https://edge.fullstory.com` and `https://rs.fullstory.com`.
- `img-src` — add `https://rs.fullstory.com`.
- For EU-hosted orgs, substitute the EU equivalents: `https://edge.eu1.fullstory.com` and `https://rs.eu1.fullstory.com` (and `https://rs.eu1.fullstory.com` for `img-src`).

If no CSP is configured, no changes needed — note that in the plan.

## Step 3: Present plan{{PLAN_GATE}}

Before changing any code, put together a single plan that covers everything below. For each item, name the specific file path and show enough surrounding code context that placement can be verified.

1. **Snippet placement** — which file, which insertion point in the component tree or HTML head.
2. **CSP changes** — directive-by-directive list, or "none needed."
3. **Open questions** — anything framework-specific, ambiguous, or places where you couldn't find what Step 2 was looking for.

{{PLAN_GATE_DETAIL}}

## Step 4: Install the snippet

This is the snippet to install. It is specific to this organization — install it exactly as given, do not alter the org id, host, or script values:

```html
{{SNIPPET}}
```

1. Insert the snippet at the location confirmed in the plan.
2. Verify syntactic correctness in context — no broken imports, valid JSX, matched tags.
3. If the plan included CSP changes, apply them now.

### Framework patterns

- Shopify Hydrogen — Do NOT paste the raw snippet. Install the wrapper package instead; it handles the snippet, Hydrogen's nonce-based CSP, and consent gating through Shopify's Customer Privacy API:
  1. `npm install @subtextdev/hydrogen` (match the project's package manager: pnpm/yarn/bun if a corresponding lockfile exists).
  2. Derive the configuration from the snippet in Step 4 above — do not invent values: `orgId` is the `window['_fs_org']` value; if `window['_fs_host']` is `eu1.fullstory.com` pass `region="eu"`; if the host values are anything other than `fullstory.com`/`eu1.fullstory.com` standards, pass them through as `host`/`script` props.
  3. `app/root.tsx` — add `<Subtext orgId="…" />` (plus `region`/`host`/`script` if derived above) inside `<head>` of the root layout. The component attaches Hydrogen's CSP nonce automatically via `useNonce()`.
  4. `app/entry.server.tsx` — wrap the existing directives object: `createContentSecurityPolicy(withSubtextCSP({...existing directives}))`, importing `withSubtextCSP` from `@subtextdev/hydrogen` (pass `{region: 'eu'}` as its second argument for EU orgs). This replaces the manual CSP directive edits from Step 2 — do not also add the directives by hand.
  5. `app/root.tsx` — add `<SubtextAnalytics />` anywhere inside `<Analytics.Provider>`. It forwards Hydrogen's commerce events (`product_viewed`, `cart_updated`, search, collection, add/remove-to-cart) into capture and starts/stops capture as Customer Privacy consent changes.
  6. Identity and analytics linkage for Hydrogen ride on this wrapper too (via the `useSubtextIdentity` hook and `<SubtextAnalytics onSessionUrl={…}>`), so they are handled in the follow-up enrichment step — not here. Get the snippet, CSP, and `<SubtextAnalytics />` in place now.
  7. Order → session linkage (optional but recommended — ask the user, or include it in autonomous mode): pass `attachSessionToCart` to `<SubtextAnalytics>`. It writes the session URL onto the cart as a `_subtext_url` custom attribute, which Shopify carries through checkout onto the order — visible in the Shopify admin under "Additional details" on every order. This requires the app's cart route action to handle `CartForm.ACTIONS.AttributesUpdateInput`; if its switch lacks that case, add: `case CartForm.ACTIONS.AttributesUpdateInput: result = await cart.updateAttributes(inputs.attributes); break;`. If the cart route is not at `/cart`, pass `attachSessionToCart={{cartRoute: '…'}}`. Leakage note to relay to the user: order attributes can appear in customized order-notification email templates (default Shopify templates do not render them; the `_` prefix is the convention templates use to filter internal attributes). The URL is auth-gated either way. If the user cannot vouch for their notification templates, use `attachSessionToCart={{mode: 'ref'}}`, which writes an opaque session id (`_subtext_ref`) instead of a clickable URL.
  8. Capture is consent-gated by default, matching how Shopify gates its own analytics. Tell the user: Shopify's privacy banner does not load on default `*.oxygen` preview URLs, so capture will not start there — verify on a real domain. Also note checkout hands off to Shopify-hosted pages, which this integration does not capture.
- Next.js (App Router) — Add to `app/layout.tsx` inside `<head>`, or as a `<Script>` component with `dangerouslySetInnerHTML`.
- Next.js (Pages Router) — Add to `pages/_document.tsx` inside `<Head>`.
- Remix — Add to `app/root.tsx` inside `<head>` of the root layout.
- Vite / CRA / Plain HTML — Add the `<script>` tag to `index.html` inside `<head>`.
- React Native — Install `@fullstory/react-native`, then add `init({ orgId: '<ORG_ID>' })` to the app entry point.

## Step 5: Explain

Once the snippet is in place, {{EXPLAIN_VERB}}:

"The Subtext capture snippet is installed. Once deployed, sessions will start capturing on your next page load — DOM snapshots, clicks, scrolls, network requests, and console output."

This install covered snippet capture only. Identifying users, linking the session URL into your analytics tools, and masking sensitive data are a separate follow-up step — the Subtext setup wizard will offer it next.
