# Implementation notes — team configuration hardening

Plan: current Codex task plan

## Decisions

- Reuse the existing Tauri HTTP-origin gate for every workspace-config URL fetch; do not add a second network path.
- Treat endpoint changes as credential-boundary changes: clear affected credentials and force a Rocket.Chat re-login.
- Keep private Git clone outside this repair; the supported contract remains an anonymously reachable Raw URL or a local file.
- Reuse Tauri's native signed updater for HTTP sources. Shared-directory packages are verified with the exact same embedded Minisign public key before launch.
- Keep team updates user-confirmed: the background timer only fetches, compares and notifies.

## Deviations

- The first-run connectivity check is intentionally limited to Rocket.Chat. ADO and AI cannot be meaningfully verified before the user's PAT/key exists; the UI now says this explicitly instead of claiming they were checked.

## Surprises

- `mergeAppliedFields()` dropped `follow` and `lastCheckedAt`, and could retain an old URL after switching to a local file.
- Tauri plugin HTTP bodies are chunked and use a trailing control byte; the Playwright desktop mock now models that protocol so URL fetch tests exercise the real read path.

## Questions for review
