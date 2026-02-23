# Publishing to npm

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and npm publishing, with automated CI via GitHub Actions.

## Automated workflow (recommended)

### 1. Add a changeset with your PR

```bash
npx changeset
```

Select the bump type (patch/minor/major) and write a summary of changes. This creates a markdown file in `.changeset/` that describes the change. PRs without a changeset will fail the "Changeset Check" status check.

### 2. Merge your PR to main

The `release.yml` workflow runs on every push to `main`. When pending changesets exist, it creates a **"chore: version packages"** PR that:
- Bumps `package.json` version
- Updates `CHANGELOG.md`
- Consumes the `.changeset/` files

### 3. Merge the version PR

When you merge the version PR, the workflow detects no pending changesets and runs `npm run release` to build and publish to npm.

Authentication uses **npm OIDC Trusted Publishing** — no tokens or secrets required. The GitHub Actions workflow authenticates directly with npm via OpenID Connect.

## Manual workflow

If you need to publish manually:

```bash
npx changeset           # add a changeset
npx changeset version   # bump version + update changelog
npm run release          # build + publish
```

Manual publishing requires `npm login` with web auth (`npm login --auth-type=web`).

## Setup

### npm Trusted Publishing (one-time)

Configure at https://www.npmjs.com/package/electric-agent/settings:
1. Add a Trusted Publisher → GitHub Actions
2. Organization/user: `balegas`
3. Repository: `create-electric-app`
4. Workflow: `release.yml`

### Branch protection (optional)

Add "Changeset Check" as a required status check in GitHub branch protection settings to enforce changesets on all PRs.

## Package Contents

The `files` field in `package.json` controls what gets published:

- `dist/` — compiled TypeScript + built React SPA
- `playbooks/` — agent playbook markdown files
- `README.md`

## Sprites Bootstrap

The Sprites sandbox provider installs the CLI globally via:

```bash
npm install -g electric-agent
```

After publishing a new version, Sprites automatically pick it up — the bootstrap checkpoint includes the package version, so a new release triggers a fresh install.

For development/testing, you can use `npm pack` to create a tarball and install it in the sprite manually, or use the `AGENT_PACKAGE_URL` env var with a pkg-pr-new preview URL.
