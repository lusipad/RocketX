# Release evidence and publication

> Document status: **current release procedure**. Release history belongs in [`CHANGELOG.md`](../../CHANGELOG.md); feature availability belongs in the [functional specifications](../specs/README.md).

The current release target is `v0.43.18`. A `0.x` release must pass the version, changelog, trusted-tag, build, artifact, checksum, and explicit publication controls below, but it does not claim 1.0 maturity. npm publication is an independent package-delivery step and does not block a verified desktop/GitHub Release. Real product visuals and two external developer runs become mandatory only when the major version is 1 or higher.

`v0.43.18` carries the first-trust LAN handshake correction validated with two independent accounts and a 559,320,082-byte direct transfer; internal LAN keys remain local and are never sent as chat messages.

`v0.43.17` carries the Rust formatting correction required by the release workflow so all platform build jobs can reach packaging.

`v0.43.16` makes LAN file transfer explicit from the chat composer, requiring a successful one-to-one handshake before file selection; ordinary messages and server uploads no longer use LAN fallback. It also streams native uploads from disk and hides legacy LAN control messages from chat history.

`v0.43.15` fixes two conversation-targeting gaps on the published `v0.43.14` line. When a global search hits both a multi-person conversation and a username, entering that conversation now opens the members panel with the matched member located and highlighted (Issue #364). Direct and multi-person DMs can also mention people outside the conversation: directory matches are labelled as not in the conversation, insert only the mention text, and never trigger an invite (inviting into a DM would create a new conversation), while group channels keep the existing invite-before-send behavior.

`v0.43.14` completes the Issue #356 runtime-boundary convergence: Native Host, Codex/DSH, LAN discovery and transfer, Rocket.Chat domain clients, and versioned local-data migration keep their existing IPC, REST, realtime, storage-key, and cross-platform release contracts.

`v0.43.11` builds on the published `v0.43.9` line. It opens the daily-work-loop line from `docs/specs/daily-loop.md` with the focus-mode MVP: a first-level navigation entry starts a timed or open-ended focus session that forces notification aggregation (the zen-mode penetration whitelist still applies), stops taskbar flashing, switches presence to busy, restores the previous presence on end, and closes with a digest card counting held-back and penetrated messages. It also adds alias import/export scoped to person aliases only (`u:` keys, filling gaps without overwriting; room aliases stay on the account-sync channel), and collapsible over-long messages with an account-synced toggle and a fold threshold estimated from half the viewport (adjustable to one or two screens in Settings → Messages).

`v0.43.6` builds on the verified `v0.43.5` transport and cross-platform packaging line. It adds server-aware long-message chunking, restores direct-message mentions without global broadcast behavior, imports archived aliases after a successful preference write, relaxes system DSH checks to the verified semver floor, and adds the corresponding auto-away, notification, preference-cache, reverse-MCP attachment, Rocket.Chat 8.6 preference, and Azure DevOps compatibility fixes. The client keeps the existing offline and optimistic-send paths while confirming uncertain message results before continuing a multi-part send. The release line remains split: default slim desktop artifacts only probe installed Codex/DSH runtimes, and a system DSH is accepted only when RocketX has verified the `@deepseek-ai/dsh@0.1.0-rc.6` minimum support line. The Windows full installer continues to ship the exactly locked private DSH runtime, private Node payload, fixed Codex payload, and OCR resources into private application data. Uninstalling either package may remove RocketX-owned private resources but must never remove npm/pnpm global DSH installations. A source checkout of `deepseek-harness` is never a release prerequisite. Earlier unpublished candidates remain documented in their changelog entries.

`v0.43.9` builds on the published `v0.43.8` line. It fixes upgrade-time "Unable to uninstall" failures: the NSIS installer and uninstaller now sweep processes that still run from the install directory before replacing files (matched by executable path with up to ten seconds of lock-release waiting), so a slow-to-exit app or the full package's private runtime processes (such as `node.exe`) can no longer make the old uninstaller leave files behind and abort the outer installer.

`v0.43.8` builds on the published `v0.43.6` line; the `v0.43.7` candidate was withheld after the release gate caught a stale compatibility-matrix version line before any artifact was built. It adds upload pre-checks with zero-copy multipart sends (#355), repairs SMB shared-directory auto-updates that the NSIS image-name process check killed (#354), and restores the `rocketx_business` room tools after ADO credential sync failures (#309). It delivers the notification sound, alias-aware `chat.postMessage` chunking, presence-button sync, conversation-menu scroll dismissal, Tauri command cleanup, and the TFS 2015/2017/2018 version mapping refinements that landed after the `v0.43.6` tag. LAN file transfer now applies a configurable size threshold (50 MiB by default) with a one-time notice, keeps an offline fallback that ignores the threshold when the Rocket.Chat upload fails or the file exceeds the server limit, and marks direct-LAN file messages on both sides while withholding server-dependent actions from them. Message text UNC share paths render as clickable cards that open through the system after an explicit confirmation on desktop. Windows full-package startup probes DSH/Codex off the main thread in parallel, caches the bundled-runtime archive checksum by file metadata, and no longer blocks first paint on AI runtime probing.

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
4. `Desktop Build` creates a draft Release and builds the Windows NSIS slim, MSI, and full installers; the macOS universal DMG and updater archive; the Linux AppImage, DEB, and RPM packages; updater metadata and signatures. Slim artifacts only probe installed runtimes and accept system DSH only after RocketX has verified the exact `0.1.0-rc.6` support line; the Windows full installer carries the private DSH/Codex/private-Node payloads and the OCR resources. It does not publish the draft.
5. `Prepare Release` runs after the multi-platform `build` job succeeds. It packages the plugin bundle, verifies all uploaded artifacts, generates `SHA256SUMS.txt`, and writes the release notes from `CHANGELOG.md` into the draft Release. It does not publish the draft.
6. If the release changes the public SDK or CLI and npm delivery is required, run `Publish npm packages` with confirmation `publish vX.Y.Z`. The protected job publishes `@lusipad/rocketx` first and `create-rcx-app` second. Bootstrap each new package against the immutable tag with npm's interactive identity flow, then bind this exact workflow as its Trusted Publisher; later releases use GitHub OIDC without a stored npm token. This step is independent from the desktop Release.
7. Review the draft, then run `Publish GitHub Release` with the same confirmation. It rechecks the three-platform artifacts and checksums, publishes the new Release as Latest, and asserts `gh api repos/$GITHUB_REPOSITORY/releases/latest` returns the new tag.

Never delete and recreate a released npm version or rewrite an existing release tag.

## Plugin bundle

The `Prepare Release` job packages every directory under `plugins/` into `rocketx-plugins-<version>.zip` and uploads that archive to the draft GitHub Release before checksums are generated. Regular iframe plugins in that archive can be installed with **Settings → Apps → Install local app**. Plugins that declare `native:service`, including `intranet-link`, are signed built-ins: the archive contains their auditable source, while their executable Sidecar is delivered only inside the RocketX desktop package and cannot be granted to a directory or URL install.
