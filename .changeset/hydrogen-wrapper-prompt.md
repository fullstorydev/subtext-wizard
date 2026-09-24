---
'@subtextdev/subtext-wizard': patch
---

Teach the install prompt the Shopify Hydrogen route: detect `@shopify/hydrogen` (before its Remix/React Router/Vite dependencies can shadow the match) and install via the `@subtextdev/hydrogen` wrapper package — snippet + CSP nonce via `<Subtext>`, `withSubtextCSP` in `entry.server`, commerce events + consent-gated capture via `<SubtextAnalytics>`, identity via `useSubtextIdentity`, and analytics linkage via `onSessionUrl` — instead of pasting the raw inline snippet. Includes the optional order → session linkage (`attachSessionToCart`: session URL as a `_`-prefixed cart attribute that lands on the order in the Shopify admin, with the `mode: 'ref'` fallback when notification templates can't be vouched for). `@subtextdev/hydrogen` also counts as "already installed" in the pre-check.
