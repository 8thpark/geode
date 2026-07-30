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
  `geode-test` bucket (storage tests) and `geode-sync-test` (sync tests, which wipe their bucket
  between scenarios and so need it to themselves), both separate from `geode-dev` so automated
  runs don't collide with whatever you're doing manually in Obsidian. Still requires Docker
  installed and Colima (or your alternative) started — it can bring the *stack* up, not the VM
  underneath it.

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

Never point this at your real vault. Run `npm run create-dev-vault` instead, it creates
`dev-vault/` inside this repo and links the repo itself in as the plugin folder
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
5. Run `Geode: Sync` from the command palette, or click the status bar icon bottom right, to
   push and pull against the storage server. Check the result either in the `Geode: Logs` pane or
   directly in the bucket:

   ```bash
   docker compose run --rm --entrypoint sh create-bucket -c \
     "mc alias set local http://minio:9000 geodedev geodedev && mc ls local/geode-dev"
   ```

Obsidian's plugin data file (`data.json`), geode's own vault state file (`state.json`), and its
log file (`geode.log`), all of which land at the repo root because the dev vault symlinks the
whole repo in as the plugin folder, are gitignored and should never be committed. The MinIO
container's data lives in a Docker volume, not a repo folder — `npm run dev:s3:reset` clears it.

## Windows

Clone the repo onto the Windows filesystem (`C:\...`, not a WSL path) and everything above just
works: `npm run create-dev-vault` detects Windows and creates the plugin folder as an NTFS
junction rather than a symlink, which needs neither Administrator rights nor Developer Mode
enabled. Install [Docker Desktop](https://www.docker.com/products/docker-desktop) for the storage
server, everything else in "Building" above is unchanged.

## WSL

WSL (Windows Subsystem for Linux) runs a real Linux environment alongside Windows, and it's a
reasonable place to clone the repo, but keep the repo and Obsidian on the same side of that
boundary. If the repo lives inside WSL, run Obsidian's Linux build inside WSL too (via
[WSLg](https://github.com/microsoft/wslg), built into Windows 11), pointed at the native
`/home/.../dev-vault` path.

Don't open that same vault from a Windows native install of Obsidian over the
`\\wsl.localhost\...` network share. Windows' client for that share has long standing trouble
following symlinks created inside WSL's filesystem, so a Windows native Obsidian fails to load the
plugin with an `ENOENT` on `dev-vault\.obsidian\plugins\geode`, even though the link is perfectly
valid from the Linux side.

## License

By contributing, you agree your contribution is licensed under this repository's
[LICENSE](./LICENSE) and that the project may relicense it as Geode evolves. This keeps future
licensing changes possible without tracking down every past contributor.

## Versioning

The project follows [Semantic Versioning](https://semver.org/). Release tags are never prefixed
with `v` (e.g. `0.1.0`), matching Obsidian's
[manifest](https://docs.obsidian.md/Reference/Manifest) specification. Pre-releases before an
official version carry a `-beta.N` suffix, e.g. `0.1.0-beta.1`. Before `1.0.0` anything may change
and the public API should not be considered stable; we aim to avoid churn, but early is early.

The version number is duplicated in `package.json` and `manifest.json`; bump both together for
every release. The README's version badge reads `package.json`, and Obsidian reads `manifest.json`.

## Releasing

Releases are cut by pushing a tag; a workflow does the mechanical work and leaves you a draft to
launch. The steps:

1. Bump `package.json` and `manifest.json` to the new version (they must agree, `check-versions`
   enforces it), open a PR, merge to `main`.
2. Tag the merged commit and push it, no `v` prefix: `git tag 0.1.0 && git push origin 0.1.0`.
   A `-beta.N` suffix marks a pre-release, e.g. `0.1.0-beta.2`.
3. The tag push triggers [`release.yml`](./.github/workflows/release.yml), which rebuilds the
   artifacts from the tagged commit (validating the tag against `manifest.json` and secret-scanning
   the exact bytes), signs them with keyless [build provenance](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds),
   and creates a **draft** GitHub release with the assets, a per-asset signed provenance bundle
   (`<asset>.sigstore.json`), and generated notes as a skeleton attached. A `-beta.N` tag is
   marked pre-release automatically.
4. Open the draft, rewrite the generated notes into real release notes, then publish. Editing notes
   and publishing is metadata only, so it never invalidates the signature over the asset bytes.

There is no long-lived signing key: provenance is signed keylessly against the workflow's GitHub
identity and recorded in a public transparency log. See [SECURITY.md](./SECURITY.md) for how anyone
verifies a downloaded release.
