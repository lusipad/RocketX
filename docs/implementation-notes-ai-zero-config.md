# Implementation notes — AI zero configuration

Plan: current Codex task plan

## Decisions

- Reuse the existing Codex app-server runtime and expose one shared readiness probe; do not add a second AI runtime.
- Automatically use Codex when its CLI, app-server capability, and login are ready.
- When Codex is unavailable, show one lightweight notice per app session and fall back to the existing API AI.
- Keep Web Provider provisioning out of this desktop-only change because it requires a server-side credential and authorization design.

## Deviations

- Dropped executable selection and one-click login from the original draft. The final flow intentionally has no setup wizard.

## Surprises

## Questions for review
