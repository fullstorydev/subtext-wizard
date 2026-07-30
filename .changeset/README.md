# Changesets

This directory holds [changeset](https://github.com/changesets/changesets) files:
per-change descriptions that drive the version bump for the
`@subtextdev/subtext-wizard` npm package.

## Workflow

1. **You open a PR.** If the change is user-facing (anything that should appear
   in the changelog or bump the version), run:

   ```sh
   npm run changeset
   ```

   Pick `patch` / `minor` / `major`, write a short summary, and commit the
   resulting `.changeset/*.md` file with your PR.

2. **PR merges to `main`.** The `release` workflow
   (`.github/workflows/release.yml`) notices the pending changesets and
   opens/updates a "Version Packages" PR that bumps `package.json` and
   writes `CHANGELOG.md`. Nothing is tagged or published yet.

3. **A maintainer merges the Version Packages PR.** That merge is itself a push
   to `main`, so the `release` workflow runs again. With no changesets left to
   consume, it publishes `@subtextdev/subtext-wizard` to npm, tags the release,
   and creates the GitHub Release, all in the same run. No manual `git tag`
   step.

## Skipping the changeset

Pure infra / refactor / docs changes that don't affect the published package
don't need a changeset. Open the PR without one.
