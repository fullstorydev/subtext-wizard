## Step 1: Check it isn't already installed

Search the HTML entry point for `fullstory.com/s/fs.js` or `_fs_script`, and source files for `window['_fs_org'] =` or `init({ orgId`. Also check `package.json` for `@fullstory/browser`, `@fullstory/react-native`, or `@fullstory/snippet`. Don't broad-search for "fullstory"; it matches unrelated copy.

If found, report "Subtext snippet already installed at {file}:{line}" and stop.

## Step 2: Explore the codebase

Read-only. Find two things:

- **Framework and entry point.** Match the project to one of the framework guides in Step 4.
- **Content-Security-Policy.** Look for a CSP in framework config (`next.config.js`, `vercel.json`, `netlify.toml`), middleware (`helmet`, `middleware.ts`), or a `<meta http-equiv="Content-Security-Policy">` tag. A CSP that blocks the snippet makes capture fail silently.

If nothing matches and there's no `index.html`, search `.html`, `.tsx`, and `.jsx` files for `<head>`, list the candidates, and ask which file to use.

## Step 3: Present plan{{PLAN_GATE}}

Before changing any code, write one plan that names the file and shows enough surrounding code to check placement:

1. **Snippet placement**: which file, and where in `<head>`.
2. **CSP changes**: directive by directive, or "none needed".
3. **Open questions**: anything ambiguous.

{{PLAN_GATE_DETAIL}}

## Step 4: Install the snippet

This snippet is specific to this org. Copy it exactly; don't change the org id, host, or script values:

```html
{{SNIPPET}}
```

Place it as early in `<head>` as possible, before the app bundle, and check the file still compiles.

### Framework guides

- **Next.js App Router** (`app/layout.tsx`): put it inside `<head>` as `<script dangerouslySetInnerHTML={{ __html: `...` }} />`, or in the body as `<Script id="subtext-snippet" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: `...` }} />` from `next/script`. The layout doesn't need `"use client"`. Don't split the snippet across `<Script>` tags.
- **Next.js Pages Router** (`pages/_document.tsx`): put it inside `<Head>` as a `<script dangerouslySetInnerHTML>`. It must live in `_document.tsx`, not `_app.tsx`.
- **Remix** (`app/root.tsx`): put it inside `<head>` as a `<script dangerouslySetInnerHTML>`, before `<Scripts />`.
- **Vite** (`index.html`): put the `<script>` inside `<head>`, before `<script type="module" src="/src/main.tsx">`.
- **Create React App** (`public/index.html`): put the `<script>` inside `<head>`. Don't import it from a JS module.
- **React Native**: there's no HTML snippet. Install `@fullstory/react-native` (plus the platform link step from its README: pod install on iOS, Gradle config on Android) and call `init({ orgId: '<ORG_ID>' })` once at the app entry point, before any screen renders. Use the org id from the snippet above. If the project keeps config in env vars (`EXPO_PUBLIC_*`, `react-native-config`), follow that convention. No CSP changes are needed.
- **Anything else** (plain HTML): put the `<script>` inside `<head>`. With several HTML entry points, add it to every page that should be recorded; a shared header template is easier than copying it.

### Content-Security-Policy

If Step 2 found a CSP, add these sources to it, editing the policy where it's defined. Keep every existing source.

US orgs (`-na1`):

- `script-src`: `https://edge.fullstory.com https://rs.fullstory.com`
- `connect-src`: `https://edge.fullstory.com https://rs.fullstory.com`
- `img-src`: `https://rs.fullstory.com`

EU orgs (`-eu1`): use `edge.eu1.fullstory.com` and `rs.eu1.fullstory.com` instead.

The snippet starts with an inline script, so `script-src` also needs `'unsafe-inline'` or a nonce on the snippet's `<script>` tag. If the app already uses nonces, use the same mechanism. Don't add `'unsafe-inline'` to a policy that doesn't already have it without asking the user.

If the policy is set in a hosting dashboard you can't edit, tell the user exactly which directives to change.

## Step 5: Explain

Once the snippet is in place, {{EXPLAIN_VERB}}:

"The Subtext capture snippet is installed. Once deployed, sessions will start capturing on your next page load: DOM snapshots, clicks, scrolls, network requests, and console output."

This install covered the snippet only. Identifying users, linking the session URL into analytics tools, and masking sensitive data come next; the Subtext setup wizard will offer them.
