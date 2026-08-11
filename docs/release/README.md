# Release evidence and publication

> Document status: **current release procedure**. Release history belongs in [`CHANGELOG.md`](../../CHANGELOG.md); feature availability belongs in the [functional specifications](../specs/README.md).

The current release target is `v0.40.1`. A `0.x` release must pass the version, changelog, trusted-tag, build, artifact, checksum, and explicit publication controls below, but it does not claim 1.0 maturity. npm publication is an independent package-delivery step and does not block a verified desktop/GitHub Release. Real product visuals and two external developer runs become mandatory only when the major version is 1 or higher.

`v0.34.5` restored the official Windows x64, macOS universal, and Linux x64 desktop Release. Starting with `v0.35.0`, the protected workflow continues to publish the verified three-platform Release as GitHub Latest and checks that `gh api repos/$GITHUB_REPOSITORY/releases/latest` resolves the new tag. Windows updater metadata must continue to select the slim NSIS installer rather than the optional full package.

The macOS bundle uses Tauri's supported ad-hoc signing identity because this repository does not yet have Apple Developer signing and notarization credentials. This prevents an entirely unsigned universal app while keeping the limitation explicit: the DMG is not Apple-notarized and may require manual approval in macOS Privacy & Security.

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
3. Push `release/vX.Y.Z` at the verified `main` commit. `Tag Version` refuses any other commit, mismatched version, or existing tag; 1.0+ additionally refuses missing visuals or external evidence.
4. `Desktop Build` creates a draft Release and verifies the Windows NSIS slim, MSI, and full installers; the macOS universal DMG and updater archive; the Linux AppImage, DEB, and RPM packages; updater metadata and signatures; and the plugin bundle. It writes release notes from `CHANGELOG.md` and uploads a directly usable `SHA256SUMS.txt`. It does not publish the draft.
5. If the release changes the public SDK or CLI and npm delivery is required, run `Publish npm packages` with confirmation `publish vX.Y.Z`. The protected job publishes `@lusipad/rocketx` first and `create-rcx-app` second. Bootstrap each new package against the immutable tag with npm's interactive identity flow, then bind this exact workflow as its Trusted Publisher; later releases use GitHub OIDC without a stored npm token. This step is independent from the desktop Release.
6. Review the draft, then run `Publish GitHub Release` with the same confirmation. It rechecks the three-platform artifacts and checksums, publishes the new Release as Latest, and asserts `gh api repos/$GITHUB_REPOSITORY/releases/latest` returns the new tag.

Never delete and recreate a released npm version or rewrite an existing release tag.

## Plugin bundle

The desktop release workflow packages every directory under `plugins/` into `rocketx-plugins-<version>.zip` during the release gate and uploads that archive to the draft GitHub Release before checksums are generated. Regular iframe plugins in that archive can be installed with **Settings → Apps → Install local app**. Plugins that declare `native:service`, including `intranet-link`, are signed built-ins: the archive contains their auditable source, while their executable Sidecar is delivered only inside the RocketX desktop package and cannot be granted to a directory or URL install.

