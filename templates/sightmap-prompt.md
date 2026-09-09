Build a sightmap component corpus for this app so Subtext session reviews come back with semantic component names instead of raw CSS selectors.

{{MODE_SECTION}}

## Reference

A sightmap is a `.sightmap/` corpus: a `components.yaml` of global components plus per-view YAML under `.sightmap/views/`, each mapping a stable component id to the selectors that identify it in the DOM. Subtext reads this corpus when it annotates session snapshots.

If a `sightmap-authoring` skill is available in this environment, use it — it is the source of truth for the corpus format and the authoring workflow. If it isn't, fetch https://docs.sightmap.org/start/quickstart and use the docs as your reference. Either way, the `sightmap` CLI (`validate`, `lint`, `snapshot`) is already installed and on PATH.

## Step 1: Check the tooling

Run `sightmap --version` to confirm the CLI is available. If the command is missing, install it with `npm install -g @sightmap/sightmap` and try again. If it still can't be installed, stop and report that the CLI is unavailable — the rest of this task depends on it.

## Step 2: Seed the corpus from the codebase

Do a read-only pass over the app's UI code — routes/pages, shared layout, and the reusable components that make up the meaningful surfaces (navigation, forms, product/list items, dialogs, account and settings screens). For each one that a person would name when describing the page ("the add-to-cart button", "the search box"), define a sightmap component with a stable id and the selector that identifies it.

- Prefer durable selectors: `data-testid`, `data-*` hooks, roles, and stable ids over brittle class chains.
- Put app-wide components (header, nav, footer, global search) in `components.yaml`; put view-specific ones in the matching file under `.sightmap/views/`.
- Name views after the routes they cover. Don't invent components for markup that doesn't exist — only map what's really in the code.

## Step 3: Validate and lint

Run `sightmap validate` and `sightmap lint`. Fix whatever they flag — malformed YAML, duplicate ids, selectors that don't parse — and re-run until both pass clean.

{{LIVE_SECTION}}

## Step {{REPORT_STEP}}: Report

{{REPORT_VERB}} what you built: the number of components and views authored, which surfaces are covered, and any notable gaps you couldn't map from the code (dynamic routes, third-party embeds, anything that needs a running app to see). {{REPORT_LOCATION}}
