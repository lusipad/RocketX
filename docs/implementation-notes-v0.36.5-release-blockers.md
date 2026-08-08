# Implementation notes — v0.36.5 release blockers

Shipped vs plan: four confirmed blockers are closed without changing the deterministic workspace or duplicating Skill behavior. ADO Windows credentials are collection-bound, the runner uses system PowerShell, and generic scheduled tasks only expose zero-parameter Skills. Windows and Linux UI baselines plus the full release contract now pass.

Plan: current Codex task plan for the four confirmed release blockers.

## Decisions

- `apps/desktop/src-tauri/src/proc.rs`: Windows integrated authentication must remain inside the configured Azure DevOps collection boundary.
- `apps/desktop/src-tauri/src/proc.rs`: the ADO runner must use Windows' system PowerShell, not a `PATH`-resolved executable.
- `apps/desktop/src-tauri/src/proc.rs`: the hosted runner drops ambient alternate-host environment variables; dedicated hosts require a future explicit trusted configuration.
- `apps/web/src/components/ButlerRoutineCreateDialog.tsx`: the generic scheduled-task form only offers Skills that can run without missing structured parameters.
- `tests/ui/butler-workspace.spec.ts`: Linux snapshot updates may only record already-reviewed layout changes.
- Verification: Rust `83/83`, pure tests `230/230`, regression tests `980/980`, Windows Playwright `108/108`, Ubuntu Butler Playwright `20/20`, typecheck, web build, Codex protocol, ecosystem packaging, and the `v0.36.5` release contract all pass.

## Deviations

- None. Dedicated alternate ADO hosts remain disabled until they can be represented as explicit trusted configuration.

## Surprises

- The Linux failures were deterministic stale screenshots rather than flaky rendering; exactly nine reviewed baselines changed.
- The generic scheduled-task entry previously accepted `room-digest` without collecting its required room scope.

## Questions for review

- None for this candidate scope.
