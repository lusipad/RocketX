# Contributing to RocketX

Thank you for helping improve RocketX. Keep each change focused, explain the user-visible reason, and include evidence that the affected behavior works.

## Before you start

- Search existing issues and pull requests for overlapping work.
- For a bug, describe the smallest reproduction, expected behavior, actual behavior, platform, and Rocket.Chat version.
- For a larger feature or protocol change, open an issue before implementation so the trust boundary and compatibility impact can be agreed first.
- Never include production credentials, access tokens, private messages, customer URLs, or personal data.

Security reports must follow [SECURITY.md](SECURITY.md), not the public issue tracker.

## Development environment

The CI baseline uses Node.js 22 and pnpm 11.12.0. Docker is required for the reproducible Rocket.Chat test stack. Desktop changes also require Rust stable and the platform-specific [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
corepack enable
pnpm install --frozen-lockfile
docker compose -f docker/docker-compose.yml up -d
pnpm dev
```

RocketX development runs at <http://localhost:5173>; the pinned Rocket.Chat server runs at <http://localhost:3300>. The local development account is `admin` / `rcxdev123`.

## Change guidelines

- Make the smallest change that solves the stated problem. Do not combine unrelated cleanup or formatting.
- Preserve the public Rocket.Chat API boundary; do not patch the Rocket.Chat server or create private server tables.
- Reuse the shared manifest and Bridge contracts from `@rcx/app-sdk` rather than defining a second copy.
- Do not add a dependency without explaining why existing code or platform APIs are insufficient.
- Add or update a regression test before changing behavior when practical.
- Keep third-party application permissions minimal and document any new capability or trust boundary.
- Update English and Chinese documentation together when user-facing instructions change.

## Verification

Run the checks relevant to your change. A normal TypeScript change should include:

```bash
pnpm typecheck
pnpm test:pure
pnpm test:regression
pnpm test:ui
```

Changes to Rocket.Chat API behavior should also run the real-server checks:

```bash
pnpm smoke
pnpm test:classify
```

Desktop or Rust changes should include:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
pnpm --filter @rcx/desktop tauri build --no-bundle
```

Application ecosystem changes should validate the SDK package, CLI clean-room flow, and official examples using the repository scripts present in `package.json`. Docker changes should at minimum pass:

```bash
docker compose -f docker/docker-compose.yml config --quiet
docker compose -f docker/docker-compose.yml build rocketx
```

UI changes should extend `pnpm test:ui` when the behavior is automatable, then add a real browser or desktop interaction pass for surfaces the suite does not cover. Record the path tested and the result in the pull request.

## Pull requests and commits

- Summarize the problem and the chosen approach.
- List changed behavior, test commands and results, compatibility impact, and known verification gaps.
- Keep generated files and lockfiles in the same pull request as the source change that requires them.
- Do not claim a package, tag, installer, or GitHub Release was published unless the registry or release page confirms it.
- Use the repository's Lore commit format: an intent-first subject, short rationale, and useful trailers such as `Constraint:`, `Rejected:`, `Tested:`, and `Not-tested:`.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
