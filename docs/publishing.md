# Publishing to npm

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and npm publishing, with automated CI via GitHub Actions.

## Automated Workflow (Recommended)

### 1. Add a changeset with your PR

```bash
pnpm exec changeset
```

Select the bump type (patch/minor/major) and write a summary of changes. This creates a markdown file in `.changeset/` that describes the change. PRs without a changeset will fail the "Changeset Check" status check.

### 2. Merge your PR to main

The `release.yml` workflow runs on every push to `main`. When pending changesets exist, it creates a **"chore: version packages"** PR that:
- Bumps `package.json` versions
- Updates `CHANGELOG.md`
- Consumes the `.changeset/` files

### 3. Merge the version PR

When you merge the version PR, the workflow detects no pending changesets and runs `pnpm run release` to build and publish to npm.

Authentication uses **npm OIDC Trusted Publishing** — no tokens or secrets required.

## Manual Workflow

```bash
pnpm exec changeset           # add a changeset
pnpm exec changeset version   # bump versions + update changelogs
pnpm run release               # build + publish
```

Manual publishing requires `npm login` with web auth (`npm login --auth-type=web`).

## Changeset File Format

Changeset files live in `.changeset/` and follow this format:

```markdown
---
"@electric-agent/studio": patch
---

Fix session token validation for SSE reconnection.
```

- **`patch`**: Bug fixes, small improvements
- **`minor`**: New features, non-breaking additions
- **`major`**: Breaking changes
- Only list packages that were actually modified
- File name should be a short kebab-case description (e.g., `fix-session-tokens.md`)

## npm Trusted Publishing Setup

Configure at `https://www.npmjs.com/package/<pkg>/settings`:

1. Add a Trusted Publisher → GitHub Actions
2. Organization/user: `balegas`
3. Repository: `create-electric-app`
4. Workflow: `release.yml`
