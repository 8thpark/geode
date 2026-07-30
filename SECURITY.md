# Security

Found something that doesn't look right? Thank you for taking the time to report it. Please use
[GitHub's private vulnerability reporting](https://github.com/8thpark/geode/security/advisories/new)
rather than a public issue, so there's time for a fix before the details are out in the open.

Include whatever detail you can (steps to reproduce are gold). You'll get an acknowledgement
within 7 days, and a fix or a plan within 90. Please hold off on public disclosure until a fix has
shipped; every report is appreciated, even the false alarms.

## Verifying a Release

Release artifacts are signed with keyless [build provenance](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds):
there is no long-lived signing key, the signature is tied to the GitHub Actions workflow that
produced it, and it's recorded in a public transparency log. To check a downloaded file:

```bash
gh attestation verify main.js --repo 8thpark/geode
```

Run it against each downloaded asset (`main.js`, `manifest.json`, `styles.css`). A pass proves the
file is byte-identical to what this repository's automation signed, and unmodified since.

For releases from `0.1.0` onward the attestation is stronger: the artifacts are built from source in
the release workflow, so the provenance ties them to the exact commit they came from. `0.1.0-beta.1`
predates that pipeline and was signed retroactively over its already published bytes, so its
attestation proves authenticity and integrity, not a build from source.
