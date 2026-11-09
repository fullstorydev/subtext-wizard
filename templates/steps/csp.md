# Allow Subtext in the Content-Security-Policy

First check whether the app has a CSP: look in framework config (`next.config.js`, `vercel.json`, `netlify.toml`), middleware (`helmet`, `middleware.ts`), server or hosting headers, or a `<meta http-equiv="Content-Security-Policy">` tag. If it doesn't have one, stop here; there's nothing to change. React Native apps don't need this step.

If it has one, add these sources to it, editing the policy where it's defined. Keep every existing source.

US orgs (`-na1`):

- `script-src`: `https://edge.fullstory.com https://rs.fullstory.com`
- `connect-src`: `https://edge.fullstory.com https://rs.fullstory.com`
- `img-src`: `https://rs.fullstory.com`

EU orgs (`-eu1`): use `edge.eu1.fullstory.com` and `rs.eu1.fullstory.com` instead.

The snippet starts with an inline script, so `script-src` also needs `'unsafe-inline'` or a nonce on the snippet's `<script>` tag. If the app already uses nonces, use the same mechanism. Don't add `'unsafe-inline'` to a policy that doesn't have it without asking the user.

If the policy is set in a hosting dashboard you can't edit, tell the user exactly which directives to change.

Details and per-platform examples: https://subtext.fullstory.com/api/csp.md
