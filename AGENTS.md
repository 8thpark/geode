# AGENTS.md

## Vision

- Your notes stay yours; files synced through storage you control, encrypted before they
  leave your device; no lock in, nothing held hostage, walk away any time
- Your vault becomes reachable by the agents and tools you trust, from anywhere, without a laptop
  awake; Geode makes the vault a first class citizen of the agent era
- Sync you never think about: quiet, boring, trustworthy; silence means everything is fine, and no
  edit is ever silently lost
- One system, one bucket: sync, MCP, and the API all read the same storage and the same long term
  format, so every device and every agent sees the same vault
- Free where it matters: the plugin and sync stay free for the community; convenience is what's
  paid (managed storage, hosted MCP and API)
- The test for every decision: would we point it at our own vault, and would we hand the keys to
  no one

## Documentation

Documentation is a first class citizen in this project, and is critical to be correct and update,
have the correct depth, and have the correct breadth. As changes are made to the project and it
develops, it is critical that the documentation evolves with it.

Current documentation:

- `README.md`
- `AGENTS.md`
- `SECURITY.md`
- `CONTRIBUTING.md`

## Similar Projects

- [Obsidian Sync](https://obsidian.md/sync) (5/5 risk) → first party, E2E encrypted, excellent on
  mobile, very much alive; the existential scenario is Obsidian shipping an official API/MCP on top
  of it
- [Synch](https://synch.run) (2/5 risk) → open source, E2EE, hosted at $1/month vs official
  Sync's $5; undercuts on price for the "want E2EE without the cost" crowd, but that's a
  different customer than ours, they're not bringing their own storage
- [Remotely Save](https://github.com/remotely-save/remotely-save) (2/5 risk) → 7.8k stars but no
  push since Nov 2024 and 215 open issues; the leading BYO storage sync plugin is effectively
  unmaintained, and its users are our first audience
- [Obsidian WebDAV Sync](https://github.com/hesprs/obsidian-webdav-sync) (4/5 risk) → 280 stars,
  ~4 months old but shipping releases every few days; built explicitly as Remotely Save's
  replacement, going after the exact same first audience, and already has three way sync, several
  conflict strategies, and client side encryption, ground our own `#26`/`#27` haven't caught up to
  yet; no MCP or agent story though, that half of the pitch is still ours alone
- [Sync Vault](https://github.com/abcamus/obsidian-sync-vault-ce) (4/5 risk) → 106 stars, 9k
  downloads, pushed today; the one to actually watch, it already bundles both halves of our own
  pitch, a zero space VFS across S3/WebDAV/Baidu/Aliyun AND an explicit MCP AI engine, the only
  other plugin here making that same agent era claim
- [Simple Storage Sync + Backup](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup) (3/5
  risk) → 17 stars, same S3/R2 niche as us, already ships optional E2E encryption and
  `LOCAL_`/`REMOTE_` conflict copies, our own `#26`/`#27` territory again, from a much smaller
  project
- [Twine](https://github.com/EnGassa/obsidian-twine) (1/5 risk) → 1 star, repo created six days
  ago, effectively zero traction yet, but the pitch is nearly word for word ours (R2/B2/S3,
  client side AES-256-GCM, no server, conflict copies preserved); worth naming for how crowded
  this exact niche is getting, independently, right now, not as an actual threat today
- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) (3/5 risk) → 11.5k stars and
  very active; real time CouchDB sync for self hosters, same job, more demanding setup
- [obsidian-git](https://github.com/Vinzent03/obsidian-git) (2/5 risk) → 11.5k stars and very
  active, alongside iCloud and Syncthing; free and good enough for simple setups; they cap the sync
  market, not the agent access market
- [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) (2/5 risk) → 2.6k
  stars, active, ships a built-in MCP server; strong locally but requires Obsidian running on an
  awake machine
- Remote MCP via tunnels and hosted connectors
  ([obsidian-web-mcp](https://github.com/jimprosser/obsidian-web-mcp), 146 stars and young, and
  [MCPBundles](https://www.mcpbundles.com)) (4/5 risk) → early movers on our paid layer; all still
  need a live device or a tunnel to the vault, whereas Geode reads from storage with nothing awake
- Desktop agents reading vault files directly (Claude Desktop, Claude Code, etc) (2/5 risk) → the
  good enough default whenever the laptop is on; always on access is the differentiation to protect
- Hosted PKM with native AI ([Notion](https://notion.com), [Anytype](https://anytype.io),
  [Capacities](https://capacities.io)) (3/5 risk) → the long game threat is users leaving Obsidian
  entirely, not picking a rival plugin

## Remember

- Less is always more, simple is always better, boring is best, to avoid the magic!
- Whilst still meeting requirements, being secure, and delivering value for our users

## Development

- Line length is set to 100 characters for all project files

## Code Style

Write TypeScript as if it were Go: simple, explicit, boring. When unsure, ask what the dullest Go
programmer would do.

- The formatter is law; Biome decides and nobody debates the output
- Pure functions first; classes only where the Obsidian API demands them (`Plugin`,
  `PluginSettingTab`), and those classes are shells: methods delegate immediately to module level
  functions, no logic lives on the class
- Named exports only, except the plugin class Obsidian requires as a default export
- String literal unions over enums; `erasableSyntaxOnly` in tsconfig enforces strippable syntax
- `type` over `interface`: data shapes are structs, not contracts, and `type` can't be reopened by
  declaration merging; `interface` only if implementing a framework contract demands it
- Errors are values: domain logic returns results rather than throwing; exceptions stay at the
  framework boundary
- Explicit zero values: every type has a complete default (see `DEFAULT_SETTINGS`), never undefined
  shaped holes
- Guard clauses and early returns; flat beats nested; no `else` after a `return`
- No ternary expressions; Go doesn't have one and neither do we, write the `if` (file local helpers
  like `stringOr(v, fallback)` cover the defaulting cases)
- Braces on every `if`, even a one line body; Go's formatter won't let you drop them and neither do
  we
- Every exported symbol gets a one sentence `//` doc comment above it, Go style ("normalizeSettings
  returns..."); no JSDoc `/** */` blocks
- Table driven tests with `node:test` and `node:assert/strict`; no test framework dependencies
- Small files with one concern; no barrel files, no `utils.ts` dumping ground
- File names are kebab-case (`settings-tab.ts`); tests sit beside the code they test as
  `name.test.ts`, Go's `_test.go` pattern; graduate to package folders (`settings/tab.ts`) only when
  a concern outgrows single files
- Framework code stays thin glue; logic lives in pure modules that never import `obsidian`
- No clever generics, no decorators, no magic
- A small, focused dependency beats hand rolling something fiddly to get right (request signing, a
  mock server); it loses to hand rolling the moment it drags in a framework or an SDK we don't need

## Links

- [Obsidian Developer Documentation](https://docs.obsidian.md)
