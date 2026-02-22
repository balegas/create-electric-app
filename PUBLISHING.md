# Publishing to npm

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and npm publishing.

## Workflow

### 1. Add a changeset for your changes

```bash
npx changeset
```

Select the package, bump type (patch/minor/major), and write a summary of changes.
This creates a markdown file in `.changeset/` that describes the change.

### 2. Version the package

```bash
npx changeset version
```

This consumes all pending changesets, bumps `package.json` version, and updates the changelog.

### 3. Build and publish

```bash
npm run release
```

This runs `npm run build` then `changeset publish` to push to npm.

### Prerequisites

- Authenticate with npm: `npm login`
- Ensure `NPM_TOKEN` is set for CI publishing
- The `name` field in `package.json` must match the desired npm package name
- The `bin.electric-agent` field points to `./dist/index.js`

## Package Contents

The `files` field in `package.json` controls what gets published:

- `dist/` — compiled TypeScript + built React SPA
- `playbooks/` — agent playbook markdown files
- `README.md`

## Sprites Bootstrap

The Sprites sandbox provider installs `electric-agent` globally via:

```bash
npm install -g electric-agent
```

This requires the package to be published to npm first. For development/testing,
you can use `npm pack` to create a tarball and install it in the sprite manually.
