# Contributing

Geode is early and the shape of things is still moving, so open an issue before starting anything
nontrivial. Saves both of us a rewritten PR.

## Building

Everything is TypeScript, bundled with esbuild:

```bash
npm install
npm run dev
```

`npm run dev` runs two things side by side, via `concurrently`: an esbuild watcher that rebuilds
`main.js` on every save to `src/`, and a local mock S3 server (`s3rver`) on `localhost:4568` for
testing storage settings without touching a real bucket. Run `npm run dev:s3` on its own if you
only need the mock server.

## CI

Every push and PR runs: `npm run lint` (Biome), `npm run build` (type-check + bundle), `npm test`
(`node:test`), `npm run check-versions` (`package.json` and `manifest.json` versions must match),
and `npm run audit` (production dependencies only; dev tooling like the mock S3 server never
ships, so its advisories don't gate CI). Run these locally before pushing, they're fast. Plain
`npm audit` also works but includes that dev-only noise; `npm run audit` is the one that matches
CI. `npm run format` applies Biome's auto-fixes.

## Testing locally

Never point this at your real vault. Run `make create-dev-vault` instead, it creates `dev-vault/`
inside this repo and symlinks the repo itself in as the plugin folder
(`dev-vault/.obsidian/plugins/geode`). Safe to re-run any time.

With `npm run dev` running:

1. Open `dev-vault/` as a vault in Obsidian (Open another vault → Open folder as vault).
2. Settings → Community plugins → turn off Restricted mode, then enable Geode.
3. Settings → Geode, set Provider to Custom and fill in the mock server: Endpoint
   `http://localhost:4568`, Region `us-east-1`, Bucket `geode-dev`, Access key ID `S3RVER`, and
   add a secret with value `S3RVER` (s3rver's fixed dev credentials). Click Test Connection.
4. After changing source files, reload Obsidian to pick up the new `main.js` (Cmd-P → "Reload app
   without saving"). Installing the community Hot-Reload plugin removes the need for this step.

The mock server's data directory (`.s3rver-data/`) and Obsidian's plugin data file (`data.json`,
which lands at the repo root because the dev vault symlinks the whole repo in as the plugin
folder) are both gitignored; neither should ever be committed.

## License

By contributing, you agree your contribution is licensed under this repository's
[LICENSE](./LICENSE) and that the project may relicense it as Geode evolves. This keeps future
licensing changes possible without tracking down every past contributor.
