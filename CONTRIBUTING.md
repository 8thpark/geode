# Contributing

Geode is early and the shape of things is still moving, so open an issue before starting anything
nontrivial. Saves both of us a rewritten PR.

## Building

Everything is TypeScript, bundled with esbuild:

```bash
npm install
npm run dev
```

`npm run dev` watches `src/main.ts` and rebuilds `main.js` on every save.

## CI

Every push and PR runs three checks: `npm run lint` (Biome), `npm run build` (type-check + bundle),
and `npm run check-versions` (`package.json` and `manifest.json` versions must match). Run all
three locally before pushing, they're fast. `npm run format` applies Biome's auto-fixes.

## Testing locally

Never point this at your real vault. Run `make create-dev-vault` instead, it creates `dev-vault/`
inside this repo and symlinks the repo itself in as the plugin folder
(`dev-vault/.obsidian/plugins/geode`). Safe to re-run any time.

With `npm run dev` running:

1. Open `dev-vault/` as a vault in Obsidian (Open another vault → Open folder as vault).
2. Settings → Community plugins → turn off Restricted mode, then enable Geode.
3. Open the developer console (Cmd-Option-I on macOS) to watch the `geode: ...` log lines from
   `onload`, `active-leaf-change`, `file-open`, and `layout-ready`.
4. After changing `src/main.ts`, reload Obsidian to pick up the new `main.js` (Cmd-P → "Reload app
   without saving"). Installing the community Hot-Reload plugin removes the need for this step.

## License

By contributing, you agree your contribution is licensed under this repository's
[LICENSE](./LICENSE) and that the project may relicense it as Geode evolves. This keeps future
licensing changes possible without tracking down every past contributor.
