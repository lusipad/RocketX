# v1.0 external acceptance evidence

The `v1.0.0` tag workflow requires two JSON evidence files. Do not add them until the runs were completed by two different people who had not previously used RocketX.

`v1.0.0-g3.json`:

```json
{
  "gate": "G3",
  "result": "pass",
  "tester": "external-developer-alias",
  "document": "README.md",
  "startedAt": "2026-07-17T09:00:00Z",
  "completedAt": "2026-07-17T09:20:00Z",
  "artifacts": ["private acceptance log or recording reference"]
}
```

`v1.0.0-g4.json` uses gate `G4` and document `docs/app-development.md`. Each run must finish within 30 minutes and reference at least one retained log, recording, or observer note. Do not commit personal names, credentials, server URLs, or other private data.

## Release sequence

1. Configure required reviewers for the `npm-release` and `release` GitHub environments, and protect the `v*` tag namespace so only the release path can create tags.
2. Commit the dated changelog section, real README PNG/GIF, and the two evidence JSON files.
3. Push `release/v1.0.0` at the verified `main` commit. `Tag Version` refuses any other commit, mismatched version, existing tag, missing visual, or missing evidence.
4. `Desktop Build` creates a draft Release, verifies every platform and updater signature, writes release notes from `CHANGELOG.md`, and uploads a directly usable `SHA256SUMS.txt`. It does not publish the draft.
5. Run `Publish npm packages` with confirmation `publish v1.0.0`. The protected job publishes `@rcx/app-sdk` first and `create-rcx-app` second. A first publication requires a short-lived granular `NPM_TOKEN`; after both packages exist, configure npm Trusted Publishing for this exact workflow and revoke the bootstrap token.
6. Review the draft, then run `Publish GitHub Release` with the same confirmation. It rechecks evidence, artifacts, checksums, and both public npm versions before making the Release public and latest.

Never delete and recreate a released npm version or rewrite an existing release tag.
