# Security

Found something that doesn't look right? Thank you for taking the time to report it. Please use
[GitHub's private vulnerability reporting](https://github.com/8thpark/geode/security/advisories/new)
rather than a public issue, so there's time for a fix before the details are out in the open.

Include whatever detail you can (steps to reproduce are gold). You'll get an acknowledgement
within 7 days, and a fix or a plan within 90. Please hold off on public disclosure until a fix has
shipped; every report is appreciated, even the false alarms.

## Verifying a Release

Every release artifact is signed with keyless [build provenance](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds):
there is no long-lived signing key, the signature is tied to the GitHub workflow and commit that
built it, and it's recorded in a public transparency log. To confirm a downloaded file is genuine:

```bash
gh attestation verify main.js --repo 8thpark/geode
```

Run it against each downloaded asset (`main.js`, `manifest.json`, `styles.css`). A pass means the
bytes came from this repository's release workflow at the tagged commit, untouched since.
