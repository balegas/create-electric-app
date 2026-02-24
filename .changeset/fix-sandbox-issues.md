---
"electric-agent": patch
---

Fix Vite allowedHosts, git push in sandboxes, and add CI release automation

- Fix Vite `allowedHosts` to use `true` (boolean) instead of invalid `"all"` string
- Fix git push path mismatch by skipping directory dedup suffix when project name is explicit
- Configure `gh` as git credential helper in Sprites and Docker sandboxes so `git push` authenticates via `GH_TOKEN`
- Add proper error logging to `gitAutoPush` instead of silently swallowing failures
- Version Sprites checkpoint comment by package version for automatic invalidation on new releases
- Add `release.yml` workflow with changesets/action + npm OIDC trusted publishing
- Add `changeset-check.yml` for PR changeset enforcement
- Fix `deploy-pr.yml` detect-changes permissions for `dorny/paths-filter`
