---
'@subtextdev/subtext-wizard': minor
---

Install the capture snippet without an agent for common frameworks. The wizard now detects Next.js (App and Pages Router), Remix, React Router, Nuxt 3+, SvelteKit, Astro, Gatsby, Angular, Vite, Create React App, Vue CLI, and plain HTML sites, previews the exact edit, and writes it after you confirm. Already-installed snippets are detected and left alone. Monorepo roots, projects with a Content-Security-Policy, unrecognized frameworks, ambiguous layouts, a declined edit, or a failed write all fall back to the agent-driven install as before.
