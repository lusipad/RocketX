# Release evidence and publication

The current release target is `v0.20.0`. A `0.x` release must pass the version, changelog, trusted-tag, build, artifact, checksum, npm, and explicit publication controls below, but it does not claim 1.0 maturity. Real product visuals and two external developer runs become mandatory only when the major version is 1 or higher.

## Future 1.0 external acceptance evidence

The future `v1.0.0` tag workflow requires two JSON evidence files. Do not add them until the runs were completed by two different people who had not previously used RocketX.

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

## Repository release controls

The `npm-release` and `release` environments accept deployments from `main` only and require approval from `lusipad`. Self-review remains enabled because RocketX is currently a single-maintainer project; the approval still keeps publication separate from build completion.

The active `Protect immutable v* release tags` ruleset prevents updates, force-pushes, and deletion after a `v*` tag is created. GitHub does not allow the GitHub Actions integration to be a ruleset bypass actor for this personal repository, so ref creation cannot be restricted to that integration without a separate release credential or GitHub App. Repository write access and the validated `Tag Version` workflow are therefore the creation boundary; moving the repository to an organization or installing a dedicated release App should add the `creation` rule with only that App as bypass actor.

## Release sequence

1. Verify that the protected environments and immutable `v*` tag ruleset above are still active.
2. Commit the dated changelog section. For a major version of 1 or higher, also commit the real README PNG/GIF and two evidence JSON files.
3. Push `release/v0.20.0` at the verified `main` commit. `Tag Version` refuses any other commit, mismatched version, or existing tag; 1.0+ additionally refuses missing visuals or external evidence.
4. `Desktop Build` creates a draft Release, verifies every platform and updater signature, writes release notes from `CHANGELOG.md`, and uploads a directly usable `SHA256SUMS.txt`. It does not publish the draft.
5. Run `Publish npm packages` with confirmation `publish v0.20.0`. The protected job publishes `@rcx/app-sdk` first and `create-rcx-app` second. A first publication requires a short-lived granular `NPM_TOKEN`; after both packages exist, configure npm Trusted Publishing for this exact workflow and revoke the bootstrap token.
6. Review the draft, then run `Publish GitHub Release` with the same confirmation. It rechecks evidence, artifacts, checksums, and both public npm versions before making the Release public and latest.

Never delete and recreate a released npm version or rewrite an existing release tag.

## Plugin bundle

The desktop release workflow packages every directory under `plugins/` into `rocketx-plugins-<version>.zip` during the release gate and uploads that archive to the draft GitHub Release before checksums are generated. Users can download this archive, unzip it, and install any contained plugin with **Settings → Apps → Install local app** by selecting the plugin directory that contains `rcx.app.json`.

