# Implementation notes — npm scope migration v0.25.13

Plan: migrate the public SDK to `@lusipad/rocketx`, keep `create-rcx-app`, and bootstrap npm Trusted Publishing from an immutable `v0.25.13` tag.

## Summary

The repository migration targets only the public application ecosystem and its release contract. RocketX core and the desktop/GitHub Release publication path remain independent from npm.

## Decisions

- `@lusipad/rocketx` is the only public SDK identity; `create-rcx-app` remains unscoped.
- The migration ships as `v0.25.13` because `v0.25.12` is already public and immutable.
- The clean-room test derives the scoped tarball and install path from the SDK manifest instead of encoding either package identity.

## Deviations

None.

## Surprises

- The `@rcx` scope belongs to a third party and cannot be used by this project.
- A new npm package needs an interactive identity bootstrap before the repository workflow can be its long-term OIDC Trusted Publisher.

## Questions for review

None.
