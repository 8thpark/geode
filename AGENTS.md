# AGENTS.md

## Vision

The project aims to provide the following to users:

- Seamless encrypted remote sync of their Obsidian vault
- Via storage they own
- Encrypted on device, before anything leaves
- Apple Notes levels of "it just always works, I don't even think about it"
- With support for Android and iOS
- Sync you never think about: quiet, boring, trustworthy; silence means everything is fine, and no
  edit is ever lost
- Security as a first class citizen in the project
- Observability as a first class citizen in the project
- Documentation as a first class citizen in the project
- Built with agents and agentic workflows in mind
- Allowing access via MCP, CLI, and API for agents and tools, to allow users the flexibility to both
  access and work on the vault remotely, as well as build automations using their vault
- One system, one bucket: sync, MCP, and the API all read the same storage and the same long term
  format, so every device and every agent sees the same vault
- The test for every decision: would we point Geode at our own vault containing all our personal
  notes?

## Documentation

Documentation is a first class citizen in this project, and is critical to be correct and update,
have the correct depth, and have the correct breadth. As changes are made to the project and it
develops, it is critical that the documentation evolves with it.

Current documentation:

- `README.md`
- `AGENTS.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `docs/*.md`

The `docs/*.md` directory is a flat list of files, using the `TOPIC_PAGE-TITLE.md` filename format,
e.g. `technical_similar-projects.md`.

Documentation within `docs/*.md` is written in Markdown, in a casual, conversational tone, with the
end user in mind, and with the goal of being easy to understand and follow. It should start with a
TL;DR style introduction, followed by a table of contents, and then the content of the page. Pages
should start simple in complexity, and then build in to more complex and detailed sections as
needed. Be concise and to the point, and documentation across the project should feel consistent.

Note that `docs/technical_*.md` pages can be more technically focused and complex, with more detail
aimed at contributors and advanced users wanting to understand the inner workings of the project.

## Remember

Less is always more, simple is always better, boring is best, avoid the magic! Whilst still meeting
requirements, being secure, and delivering value to our users.

## Code Style

The `typescript-as-go` skill (`.agents/skills/typescript-as-go/SKILL.md`) is the source of truth for
how TypeScript is written here, comments included. Abide by every rule in it, no exceptions, and
enforce it on any code you write, change, or review.

Additional rules for the project:

1. Line length is set to 100 characters for all project files
2. Classes only where the Obsidian API demands them (`Plugin`, `PluginSettingTab`), and those
   classes are shells: methods delegate immediately to module level functions, no logic lives on the
   class; the plugin class is the one default export Obsidian requires
3. Framework code stays thin glue; logic lives in pure modules that never import `obsidian`
4. `erasableSyntaxOnly` in tsconfig enforces strippable syntax
