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
`main.js` on every save to `src/`, and a local S3 compatible server ([MinIO](https://min.io), via
Docker) on `localhost:4568` for testing storage settings without touching a real bucket. Run
`npm run dev:s3` on its own if you only need the storage server, or `npm run dev:s3:reset` to
wipe it and start clean.

Requires Docker. [Colima](https://github.com/abiosoft/colima) is the recommended way to run it on
macOS — free, open source, no GUI:

```bash
brew install colima docker docker-compose
colima start --vm-type=vz --mount-type=virtiofs
```

Every command in this repo uses the `docker compose` (plugin) form — it's what GitHub's CI runners
and Docker Desktop ship, so one command works everywhere. Colima setups need a one-time line in
`~/.docker/config.json` to register Homebrew's `docker-compose` as that plugin:

```json
{
  "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]
}
```

Docker Desktop or OrbStack work too if you'd rather use those; both bundle everything into one
installer and need no extra config.

## Testing

Two tiers, two commands:

- `npm test` — unit tests, pure functions, no I/O, no Docker required. Fast, run these
  constantly.
- `npm run test:integration` — integration tests, real HTTP against a real S3 compatible server
  (MinIO). Brings up `docker-compose.yml` itself if it isn't already running, so there's no
  manual pre-step; safe to run repeatedly regardless of current state. Runs against the
  `geode-test` bucket (separate from `geode-dev`, so automated runs don't collide with whatever
  you're doing manually in Obsidian). Still requires Docker installed and Colima (or your
  alternative) started — it can bring the *stack* up, not the VM underneath it.

Both tiers use the exact same `docker-compose.yml` MinIO setup as interactive dev — one S3
compatible server, not a second hand-rolled fake to keep in sync.

## CI

Every push and PR runs: `npm run lint` (Biome), `npm run build` (type-check + bundle), `npm test`
(unit), `npm run test:integration` (against MinIO via `docker compose`, in its own job),
`npm run check-versions` (`package.json` and `manifest.json` versions must match), and
`npm run audit` (production dependencies only; dev tooling never ships, so its advisories don't
gate CI). Run the unit/lint/build ones locally before pushing, they're fast; the integration job
needs Docker running locally to reproduce. Plain `npm audit` also works but includes dev-only
noise; `npm run audit` is the one that matches CI. `npm run format` applies Biome's auto-fixes.

## Testing locally

Never point this at your real vault. Run `make create-dev-vault` instead, it creates `dev-vault/`
inside this repo and symlinks the repo itself in as the plugin folder
(`dev-vault/.obsidian/plugins/geode`). Safe to re-run any time.

With `npm run dev` running:

1. Open `dev-vault/` as a vault in Obsidian (Open another vault → Open folder as vault).
2. Settings → Community plugins → turn off Restricted mode, then enable Geode.
3. Settings → Geode, set Provider to Custom and fill in the storage server: Endpoint
   `http://localhost:4568`, Region `us-east-1`, Bucket `geode-dev`, Access key ID `geodedev`, and
   add a secret with value `geodedev` (the dev container's fixed credentials, set in
   `docker-compose.yml`). Click Test Connection.
4. After changing source files, reload Obsidian to pick up the new `main.js` (Cmd-P → "Reload app
   without saving"). Installing the community Hot-Reload plugin removes the need for this step.

Obsidian's plugin data file (`data.json`, which lands at the repo root because the dev vault
symlinks the whole repo in as the plugin folder) is gitignored and should never be committed.
The MinIO container's data lives in a Docker volume, not a repo folder — `npm run dev:s3:reset`
clears it.

## License

By contributing, you agree your contribution is licensed under this repository's
[LICENSE](./LICENSE) and that the project may relicense it as Geode evolves. This keeps future
licensing changes possible without tracking down every past contributor.
