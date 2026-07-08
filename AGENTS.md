# AGENTS.md

## Context

- [Obsidian Developer Documentation](https://docs.obsidian.md) on building plugins and themes

## Product Vision

- Your notes stay yours: plain files, synced through storage you control, encrypted before they
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

## Competitors

Risk is out of 5. Activity last checked 2026-07.

- [Obsidian Sync](https://obsidian.md/sync) → risk 5/5 → first party, E2E encrypted, excellent on
  mobile, very much alive; the existential scenario is Obsidian shipping an official API/MCP on
  top of it
- [Remotely Save](https://github.com/remotely-save/remotely-save) → risk 2/5 → 7.8k stars but no
  push since Nov 2024 and 215 open issues; the leading BYO storage sync plugin is effectively
  unmaintained, and its users are our first audience
- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) → risk 3/5 → 11.5k stars and
  very active; real time CouchDB sync for self hosters, same job, more demanding setup
- Folder syncers ([obsidian-git](https://github.com/Vinzent03/obsidian-git) 11.5k stars and very
  active, iCloud, Syncthing) → risk 2/5 → free and good enough for simple setups; they cap the
  sync market, not the agent access market
- [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) → risk 2/5 → 2.6k
  stars, active, ships a built-in MCP server; strong locally but requires Obsidian running on an
  awake machine
- Remote MCP via tunnels and hosted connectors
  ([obsidian-web-mcp](https://github.com/jimprosser/obsidian-web-mcp), 146 stars and young, and
  [MCPBundles](https://www.mcpbundles.com)) → risk 4/5 → early movers on our paid layer; all still
  need a live device or a tunnel to the vault, whereas Geode reads from storage with nothing awake
- Desktop agents reading vault files directly (Claude Desktop, Claude Code, etc) → risk 4/5 → the
  good enough default whenever the laptop is on; always on access is the differentiation to
  protect
- Hosted PKM with native AI ([Notion](https://notion.com), [Anytype](https://anytype.io),
  [Capacities](https://capacities.io)) → risk 3/5 → the long game threat is users leaving Obsidian
  entirely, not picking a rival plugin

## Remember

- Less is always more, simple is always better, boring is best, to avoid the magic!
- Whilst still meeting requirements, being secure, and delivering value for our users

## Development

- Line length is set to 100 characters for all project files

## Priorities

- When stuck, the blocker is usually priorities, not missing information → Decide and move
- One thing done exceptionally beats five things done adequately → Depth over breadth
- Not every rough edge needs fixing now → Some fires are allowed to burn; triage ruthlessly
- Users want value per second, not seconds of value → Optimize for speed and density, not features
