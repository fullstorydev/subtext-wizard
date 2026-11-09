# Install the capture snippet by hand

You will add the snippet by editing files. This page covers the snippet only; identification, analytics linkage, and privacy come after.

## 1. Check it isn't already installed

Search the HTML entry point for `fullstory.com/s/fs.js` or `_fs_script`, and source files for `window['_fs_org'] =` or `init({ orgId`. If found, tell the user it's already installed and stop. Don't broad-search for "fullstory"; it matches unrelated copy.

## 2. The snippet

This snippet is specific to this org. Copy it exactly; don't change the org id, host, or script values:

```html
{{SNIPPET}}
```

## 3. Check for a Content-Security-Policy

Look for a CSP in framework config (`next.config.js`, `vercel.json`, `netlify.toml`), middleware (`helmet`, `middleware.ts`), or a `<meta http-equiv="Content-Security-Policy">` tag. If there is one, don't change it on this page; it's handled in its own step. A CSP that blocks the snippet makes capture fail silently.

## 4. Place it

Find the framework and follow its guide:

- **Next.js App Router** (`app/layout.tsx`): put it inside `<head>` as `<script dangerouslySetInnerHTML={{ __html: `...` }} />`, or as `<Script id="subtext-snippet" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: `...` }} />` from `next/script`. The layout doesn't need `"use client"`. Don't split the snippet across `<Script>` tags.
- **Next.js Pages Router** (`pages/_document.tsx`): put it inside `<Head>` as a `<script dangerouslySetInnerHTML>`. It must live in `_document.tsx`, not `_app.tsx`.
- **Remix** (`app/root.tsx`): put it inside `<head>` as a `<script dangerouslySetInnerHTML>`, before `<Scripts />`.
- **Vite** (`index.html`): put the `<script>` inside `<head>`, before `<script type="module" src="/src/main.tsx">`.
- **Create React App** (`public/index.html`): put the `<script>` inside `<head>`. Don't import it from a JS module.
- **React Native**: there's no HTML snippet. Install `@fullstory/react-native` (plus the platform link step from its README: pod install on iOS, Gradle config on Android) and call `init({ orgId })` once at the app entry point, before any screen renders, using the org id from the snippet. If the project keeps config in env vars (`EXPO_PUBLIC_*`, `react-native-config`), follow that convention.
- **Anything else**: put the `<script>` inside `<head>`. With several HTML entry points, add it to every page that should be recorded; a shared header template is easier than copying it.

Place it as early in `<head>` as possible, before the app bundle, and check the file still compiles.
