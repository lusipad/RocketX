# Implementation notes — Butler Skill hardening

Summary: built-in Butler Skills now distinguish complete server-backed results from truncated, cached, or partially refreshed snapshots. Natural-language PR comparison selects the self-contained `pr-comparison` Skill, while the vendored Azure DevOps Skill remains unchanged. No planned behavior was dropped.

Plan: align built-in Skill promises with RocketX tool coverage, then verify natural-language and explicit Skill execution.

## Decisions

- Keep the vendored `azure-devops-server` Skill unchanged; make `pr-comparison` a self-contained RocketX wrapper and route the Butler comparison scenario to it.
- Prefer explicit coverage metadata over treating an empty or truncated result as complete.
- Propagate Today inbox refresh failures into `list_mentions`; a cached inbox must not present itself as a complete online result.
- Advance mention and room-activity prechecks from the previous successful routine run; a failed run must not consume unseen work.
- Prepend the same successful-run cursor and room scope to native Skill, customized prompt, and legacy Skill routine paths.

## Deviations

- None.

## Surprises

- `quick_validate.py` uses the Windows locale by default and failed to read the UTF-8 Chinese Skill files under GBK. Re-running the same validator with Python UTF-8 mode validated all seven edited Skills.

## Questions for review

- None; the focused follow-up review closed its compatibility finding.
