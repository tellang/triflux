# Release Checklist

Use this checklist for the next release transaction after v10.25.0.

## Version Sync

- Run `npm run release:check-sync`.
- The version manifest includes root `triflux`, `packages/triflux`, `@triflux/core`, and `@triflux/remote`; drift in any package version must fail the gate.
- Option B catch-up brought `@triflux/core` and `@triflux/remote` back into the release operational loop after the v10.1.0 gap.

## Package Publish Order

`scripts/release/publish.mjs` publishes npm packages in dependency order:

1. `@triflux/core`
2. `@triflux/remote`
3. `triflux` from `packages/triflux`

Keep `npm publish` behind `node scripts/release/publish.mjs --execute`; without `--execute`, the script only returns the planned steps.

## Pre-Publish Checks

```bash
npm run release:check-sync
npm run release:check-mirror
(cd packages/core && npm pack --dry-run)
(cd packages/remote && npm pack --dry-run)
node scripts/release/publish.mjs --dry-run
```

Do not publish from a dirty tree unless the release operator has explicitly accepted the dirty state.
