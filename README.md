<p align="left">
  <img src="./assets/logo_circle.png" alt="Logo for the Geode project" width="100px" height="100px">
</p>

<!-- omit in toc -->
# Geode

**[Obsidian](https://obsidian.md) plugin** for remote sync, MCP, and an API for your vault.

[![GitHub Branch Check Runs](https://img.shields.io/github/check-runs/8thpark/geode/main?style=flat-square&label=ci)](https://github.com/8thpark/geode/actions/workflows/ci.yml?query=branch%3Amain)
[![OSSF Scorecard Score](https://img.shields.io/ossf-scorecard/github.com/8thpark/geode?style=flat-square&label=OSSF)](https://scorecard.dev/viewer/?uri=github.com/8thpark/geode&sort_by=check-score&sort_direction=desc)
![Plugin Version](https://img.shields.io/github/package-json/version/8thpark/geode?style=flat-square)
![GitHub Repo stars](https://img.shields.io/github/stars/8thpark/geode?style=social)

- [Why](#why)
- [Security](#security)
- [License](#license)

## Why

**Geode** syncs your vault across your devices through storage you own, encrypted before anything
leaves your hands. Your agents (like Claude and Codex) can read/write to the same vault via the MCP
and API, whilst your laptop is asleep or not. Your notes, your storage, your keys. Built for agents.

## Security

Security is top concern for the project; every change is scanned by
[GitHub's CodeQL](https://codeql.github.com), the low number of dependencies we use are audited by
[Dependabot](https://github.com/dependabot) and
[NPM Audit](https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities), all,
and our
[OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/8thpark/geode&sort_by=check-score&sort_direction=desc)
updates on every change. Please see [SECURITY.md](./SECURITY.md) if you think you have found a
vulnerability or have questions.

## License

**Geode** is available under the [Elastic License 2.0](./LICENSE), meaning it is free to use, modify,
and self host. The one thing you can't do is offer **Geode** itself to others as a hosted or managed
service.
