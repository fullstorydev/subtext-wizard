Install the Subtext capture snippet into my application so sessions can be captured.

{{MODE_SECTION}}

{{TELEMETRY_SECTION}}

## Reference

Fetch https://subtext.fullstory.com/llms.txt and use it as your SDK reference throughout this task. It indexes framework-specific install guides, API reference for `setIdentity` / `setProperties` / `getSession`, privacy classes, CSP directives, and analytics-tool linkage recipes. Pull the specific pages you need as you work each step below — do not try to memorize the whole index up front.

## Language

Always call this the Subtext snippet or capture snippet — never the "Fullstory snippet." Fullstory is the underlying technology; we are setting up Subtext.

{{INTEGRATIONS_SECTION}}

## Step 1: Pre-check

Determine whether the capture snippet is *actually* installed. The snippet is the code that loads and initializes session capture — not helper utilities, type declarations, or UI text that mentions "Fullstory."

Run these checks in order. Stop at the first positive match.

1. Package dependencies (highest confidence) — Read `package.json`. Look for `@fullstory/browser`, `@fullstory/react-native`, or `@fullstory/snippet` in `dependencies` or `devDependencies`.
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

### Existing analytics tools

Search package dependencies for the analytics SDKs listed in the "Target integrations" section above. Those are the tools the user told us this app uses — prioritize finding them. Also note any other analytics SDK you encounter along the way, and any custom shared analytics wrapper module under `/lib/`, `/utils/`, `/analytics/`.

For each one found, locate where the client is instantiated and where its identify / setUserProperties / setUserVars call is made. We'll attach the Subtext URL to that tool's user metadata in Step 6. Do NOT add new analytics tools — only work with what's already installed.

## Step 3: Present plan{{PLAN_GATE}}

Before changing any code, put together a single plan that covers everything below. For each item, name the specific file path and show enough surrounding code context that placement can be verified.

1. **Snippet placement** — which file, which insertion point in the component tree or HTML head.
2. **CSP changes** — directive-by-directive list, or "none needed."
3. **User identification** — the file and call site where the authenticated user becomes available, and the React lifecycle hook to use.
4. **Analytics tool linkage** — which analytics tools you detected and the call sites where you'll attach the Subtext URL.
5. **Privacy tags** — list each sensitive element you found, file path, line, and whether you recommend `.fs-mask` or `.fs-exclude`.
6. **Open questions** — anything framework-specific, ambiguous auth flows, or places where you couldn't find what Step 2 was looking for.

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

- Next.js (App Router) — Add to `app/layout.tsx` inside `<head>`, or as a `<Script>` component with `dangerouslySetInnerHTML`.
- Next.js (Pages Router) — Add to `pages/_document.tsx` inside `<Head>`.
- Remix — Add to `app/root.tsx` inside `<head>` of the root layout.
- Vite / CRA / Plain HTML — Add the `<script>` tag to `index.html` inside `<head>`.
- React Native — Install `@fullstory/react-native`, then add `init({ orgId: '<ORG_ID>' })` to the app entry point.

## Step 5: Identify users

Sessions are far more useful when they're tied to a specific user. Install the following `FS('setIdentity')` call into the codebase so each captured session is associated with the right person.

```js
// This is an example - don't forget to change it!
FS('setIdentity', {
  uid: '<THE_ID_THAT_YOU_USE_IN_YOUR_APP_FOR_THIS_USER>',
  properties: {
    displayName: '<DISPLAY_NAME_HERE>',
    email: '<EMAIL_HERE>',
    // Add your own custom user variables here, details at
    // https://developer.fullstory.com/browser/identification/set-user-properties/
  }
});
```

1. Find the place in the codebase where the authenticated user becomes available — login success handler, auth provider, session bootstrap, `getServerSideProps`, or equivalent. Do NOT call `setIdentity` for anonymous visitors.
2. **In React-based apps, `setIdentity` MUST be called inside a `useEffect` that fires when the authenticated user changes — not on every render and not at module top-level.** Typical shape:

   ```jsx
   useEffect(() => {
     if (!user) return;
     FS('setIdentity', {
       uid: user.id,
       properties: { displayName: user.name, email: user.email },
     });
   }, [user]);
   ```

   For non-React entry points, call it from the lifecycle hook that fires once auth resolves.
3. Replace the placeholder values:
   - `uid` → the stable user id you use internally (never email; emails change).
   - `displayName` and `email` → the user's display name and email.
   - Add any custom user properties already available on the client.
4. {{IDENTITY_GATE}}
5. Verify the file still type-checks and that the effect's dependencies are correct so it does not re-fire on every render.

## Step 6: Link the Subtext URL into existing analytics

For each analytics tool detected in Step 2, attach the current Subtext URL to that tool's user metadata. This means a teammate looking at a user in that tool can click straight through to the matching Subtext session capture.

1. Get the session URL from Fullstory once a session has started:

   ```js
   const subtextUrl = FS('getSession', { format: 'url.now' });
   ```

   This returns the URL to the current session. It is only available after Fullstory has started capturing — in React, read it inside an effect after the snippet has had a chance to initialize.

2. Send it to each detected tool as a user property. **Use the naming convention that tool already uses in this codebase** (snake_case for PostHog, camelCase for Segment, etc.). Call the field `subtext_url` or `subtextUrl` accordingly. Examples for the tools the user selected:

   ```js
{{INTEGRATION_LINKAGE_EXAMPLES}}
   ```

3. If a shared analytics wrapper module exists, attach the property there once rather than at every call site.
4. The session URL can change across sessions — re-attach whenever a new session starts or when the user is re-identified.
5. Do NOT install new analytics tools. Only attach to tools already present in the app.

## Step 7: Mask sensitive data

Sessions can capture any DOM content by default. Before deploying, identify elements that render sensitive or personally identifying information (PII) and tag them so they are excluded or masked from capture.

### Element data capture classes

Add one of these CSS classes to elements that render sensitive content:

- `.fs-exclude` — exclude the element entirely from capture (DOM tree and events)
- `.fs-mask` — keep the element shape, replace visible text with masked characters
- `.fs-unmask` — opt back in to capture inside an excluded/masked ancestor

If the app supports a consent flow, use the consent-aware variants. They behave the same but apply only until the user grants consent:

- `.fs-exclude-without-consent`
- `.fs-mask-without-consent`
- `.fs-unmask-with-consent`

### What to look for

Scan the codebase for elements that render any of the following and add the appropriate class:

- Email addresses, phone numbers, postal addresses
- Full names, usernames, profile photos
- Payment data — card numbers, CVV, billing details
- Auth secrets — passwords, MFA codes, recovery phrases
- Government IDs — SSN, tax ID, driver's license
- Health data, financial balances, account numbers
- Free-text fields where users may paste any of the above (notes, support messages, chat)

### Process

1. Walk the codebase — form inputs (`<input>`, `<textarea>`), profile and settings pages, account/billing pages, chat or messaging UIs, anywhere PII can render.
2. {{PRIVACY_GATE}}
3. Insert the class, then verify the markup still compiles.
4. **Important:** these changes only take effect after the User deploys them. Code-first rules do not retroactively mask sessions that have already been captured.

## Step 8: Explain

After installation, {{EXPLAIN_VERB}}:

"The Subtext snippet is installed. Once deployed, sessions will start capturing on your next page load — DOM snapshots, clicks, scrolls, network requests, and console output."

Also note that the privacy tags added in Step 7 only take effect on **new sessions captured after the deploy**.
