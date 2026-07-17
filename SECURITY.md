# Security Policy

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, discussion, or pull request.

Use GitHub's private vulnerability reporting flow for this repository:

<https://github.com/lusipad/RocketX/security/advisories/new>

Include the affected commit or release, operating system, deployment mode (Web or desktop), a minimal reproduction, impact, and any suggested mitigation. Remove passwords, Rocket.Chat tokens, Azure DevOps PATs, AI provider keys, private messages, and other real user data from the report.

You should receive an acknowledgement within seven days. The maintainer will coordinate reproduction, a fix, release timing, and disclosure through the private advisory. If private reporting is temporarily unavailable, open a public issue containing only a request for a private contact channel; do not include vulnerability details.

## Supported versions

Security fixes target the latest published RocketX release. During pre-release development, fixes land on `main`; an untagged commit is not a supported release. Older releases may receive a fix when the impact is severe and a safe backport is practical, but this is not guaranteed.

The Rocket.Chat server is a separate upstream product. Report a Rocket.Chat server vulnerability through Rocket.Chat's own security process unless the flaw is caused by RocketX.

## Security boundaries

- RocketX authenticates through Rocket.Chat's public APIs and must not log or commit credentials.
- Desktop AI provider credentials belong in the operating-system credential store. They must not be placed in source files, `.env` files committed to Git, browser storage, screenshots, or issue reports.
- Third-party RocketX applications run behind manifest validation, explicit permissions, and a sandboxed Bridge. Remote applications cannot request process or Agent spawning permissions.
- The authenticated M9 LAN transport and legacy IP Messenger compatibility mode are separate trust domains. IP Messenger is unauthenticated, disabled by default, and must not be treated as a trusted identity channel.
- The bundled Compose credentials and permissive CORS setting are for local evaluation. Change credentials, restrict network exposure, configure TLS, and establish backups before non-local deployment.

## Dependency and release hygiene

Review `pnpm-lock.yaml`, `apps/desktop/src-tauri/Cargo.lock`, container image tags, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when dependencies change. Release artifacts should be traced to a repository tag and the corresponding CI run; repository documentation alone is not proof that an artifact was published.
