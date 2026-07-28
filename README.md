<p align="center">
  <img src="./assets/logo_circle.png" alt="Logo for the Geode project" width="100px" height="100px">
</p>

<h1 align="center">Geode</h1>

<p align="center">
  <a href="https://github.com/8thpark/geode/actions/workflows/ci.yml?query=branch%3Amain">
    <img src="https://img.shields.io/github/check-runs/8thpark/geode/main?style=flat-square&amp;label=ci" alt="GitHub Branch Check Runs">
  </a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/8thpark/geode&amp;sort_by=check-score&amp;sort_direction=desc">
    <img src="https://img.shields.io/ossf-scorecard/github.com/8thpark/geode?style=flat-square&amp;label=OSSF" alt="OSSF Scorecard Score">
  </a>
  <a href="https://github.com/8thpark/geode/releases">
    <img src="https://img.shields.io/github/package-json/version/8thpark/geode?style=flat-square" alt="Plugin Version">
  </a>
  <a href="https://obsidian.md/changelog/">
    <img src="https://img.shields.io/badge/obsidian-1.11.4%2B-7C3AED?style=flat-square" alt="Obsidian Minimum Version">
  </a>
  <a href="https://nodejs.org/en/about/previous-releases">
    <img src="https://img.shields.io/badge/node-24%2B-339933?style=flat-square" alt="Node Minimum Version">
  </a>
  <a href="./LICENSE.md">
    <img src="https://img.shields.io/badge/license-GPL--3.0-blue.svg?style=flat-square" alt="License">
  </a>
  <a href="https://github.com/8thpark/geode/stargazers">
    <img src="https://img.shields.io/github/stars/8thpark/geode?style=social" alt="GitHub Repo Stars">
  </a>
</p>

> **[Obsidian](https://obsidian.md) plugin** for remote sync, MCP, and an API for your vault.

- [Why?](#why)
- [Changelog](#changelog)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Why?

**Geode** is a free [Obsidian](https://obsidian.md) plugin that syncs your vault across multiple
devices (including iOS) through storage that you own, and encrypted before anything leaves your
device.

Our aim is to build the best remote sync plugin available for Obsidian users; Apple Notes is the
quality bar, something that just always works and you don't even think about.

Whilst also offering a remote MCP server and API to your vault, so that any agent (e.g. Claude,
Codex) can read/write to the same vault, using it as memory. As we believe the full power of
Obsidian is unlocked via agents.

**TL;DR** → Remote sync, using storage you own, encrypted, with MCP/API for your agents to use
Obsidian as memory.

## Changelog

We are working hard to get to our first `v0.1.0` release, see
[progress](https://github.com/8thpark/geode/milestones).

## Contributing

PRs are very welcome in the project, check out issues with the
[`"Good First Issue"`](https://github.com/8thpark/geode/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22)
label and [CONTRIBUTING.md](./CONTRIBUTING.md) for more details.

## Security

Security is top concern for the project; every change is scanned by
[GitHub's CodeQL](https://codeql.github.com), the low number of dependencies we use are audited by
[Dependabot](https://github.com/dependabot) and
[NPM Audit](https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities), and
our
[OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/8thpark/geode&sort_by=check-score&sort_direction=desc)
updates on every change. Please see [SECURITY.md](./SECURITY.md) if you think you have found a
vulnerability or have questions.

## License

**Geode** is available under the [GNU General Public License v3.0](./LICENSE). You are free to use,
modify, and distribute it, provided any derivative work you distribute is also released under the
GPL-3.0.
