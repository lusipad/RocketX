---
name: azure-devops-server
description: Use for Azure DevOps Server or on-prem TFS/Azure DevOps REST work when Codex needs to inspect projects, repositories, pull requests, work items, WIQL queries, wikis, search routes, test plans, test runs, test results, builds, compare pull requests, or conditionally use releases on a collection URL. Triggers include "Azure DevOps Server", "on-prem Azure DevOps", "TFS", collection-based REST calls, PR comparison, Windows-auth/PAT automation, and cases where the official Azure DevOps MCP for Azure DevOps Services is not the right fit.
---

# Azure DevOps Server

Use this skill for current Azure DevOps Server, Azure DevOps Server 2020/2022, and best-effort older TFS scenarios. Prefer the bundled PowerShell helpers over ad hoc REST boilerplate so auth, URL handling, support boundaries, and write safety stay consistent.

## Workflow

### 1. Confirm the target fits this skill

Use this skill when the target is an on-prem Azure DevOps Server or TFS deployment and the caller can provide a collection URL such as:

- `https://ado-server/tfs/DefaultCollection`
- `https://ado-server/DefaultCollection`

Do not use this skill as a drop-in replacement for the official Azure DevOps Services MCP. This skill is intentionally narrower and server-specific.

Support policy:

- First-class: current Azure DevOps Server 20.0, Azure DevOps Server 2022/2022.1, and Azure DevOps Server 2020
- Best-effort: older TFS
- Required: `projects`, `git`, `wit`, `build`, `work`
- Supported: `wiki`, `testplan`, `test`
- Conditional: `release`, `search`, `testresults`
- Deferred: `advanced security`, `MCP-app` style integrations, and other cloud-only domains

### 2. Collect configuration and bootstrap the connection

Prefer environment variables:

- `AZURE_DEVOPS_SERVER_COLLECTION_URL`
- `AZURE_DEVOPS_SERVER_AUTH_MODE` as `pat` or `default-credentials`
- `AZURE_DEVOPS_SERVER_PAT` when auth mode is `pat`
- `AZURE_DEVOPS_SERVER_PROJECT` optional default project
- `AZURE_DEVOPS_SERVER_TEAM` optional default team for team-scoped `work` routes
- `AZURE_DEVOPS_SERVER_API_VERSION` optional override
- `AZURE_DEVOPS_SERVER_SERVER_VERSION` optional hint: `current`, `20.0`, `2022.1`, `2022`, `2020`, `2019`, `2018`, `2017`, `2015`, or `legacy`
- `AZURE_DEVOPS_SERVER_SEARCH_BASE_URL` optional override when search is exposed on a dedicated host
- `AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL` optional override when test results are exposed on a dedicated host

The helpers also fall back to pipeline-style variables when available:

- `SYSTEM_TEAMFOUNDATIONCOLLECTIONURI`
- `SYSTEM_TEAMPROJECT`

Run the bootstrap helper before other workflows:

```powershell
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 -CheckReleaseArea
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 -CheckSearchArea
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 -CheckTestResultsArea
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 -CheckReleaseArea -DryRun
```

Read [references/auth-and-configuration.md](references/auth-and-configuration.md) when auth inputs are unclear.
Read [references/url-and-resource-areas.md](references/url-and-resource-areas.md) when URL shape or area routing is unclear.

### 3. Use the generic API wrapper for supported reads

Use `scripts/Invoke-AzureDevOpsServerApi.ps1` for supported reads. Pass an explicit `-Area` and `-Resource` instead of hand-building URLs. When passing `-Query` or `-Body` hashtables, invoke the script with `&` in the current PowerShell session; a nested `pwsh -File` process stringifies those objects.

Examples:

```powershell
& .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Resource projects `
  -Query @{ '$top' = 25 }

& .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area git `
  -Project Fabrikam `
  -Resource repositories
```

Read [references/workflow-recipes.md](references/workflow-recipes.md) for common routes.
Read [references/work-support.md](references/work-support.md) for team settings, iterations, backlogs, and capacity routes.
Read [references/build-support.md](references/build-support.md) for build definitions, builds, logs, artifacts, and queue previews.
Read [references/release-support.md](references/release-support.md) for release definitions, releases, environments, deployments, and preview-first mutation flows.
Read [references/repo-support.md](references/repo-support.md) for repository, branch, and pull-request routes.
Read [references/work-item-support.md](references/work-item-support.md) for work item, WIQL, query, comment, and JSON Patch routes.
Read [references/wiki-support.md](references/wiki-support.md) for wiki listing, page reads, and pages-batch routes.
Read [references/search-support.md](references/search-support.md) for search routes and host/base-URL caveats.
Read [references/test-support.md](references/test-support.md) for test plans, suites, runs, and run-scoped result routes.
Read [references/test-results-support.md](references/test-results-support.md) for build-linked and work-item-linked test result routes.
Read [references/api-version-matrix.md](references/api-version-matrix.md) before changing `api-version`.

### 4. Inspect or compare pull requests from fixed snapshots

Use `Invoke-AzureDevOpsServerApi.ps1` for the whole workflow:

1. Resolve each explicit PR ID through collection-scoped `pullrequests/{id}`.
2. Read its iterations and select the highest iteration ID.
3. Use `commonRefCommit` as the before side and `sourceRefCommit` as the after side. Keep `targetRefCommit` as metadata only.
4. Request cumulative iteration changes with `$compareTo=0` and follow `nextSkip`/`nextTop`.
5. Read only the files needed for the conclusion. Before requesting content, check item metadata and blob size with `$format=json`; skip binary files and files above 256 KiB.

For renamed or deleted files, read `originalPath` from `commonRefCommit`. Do not guess PR IDs or paths. Keep each comparison to at most 20 file reads and 1 MiB of returned text. Do not clone the repository or perform PR writes.

Read [references/repo-support.md](references/repo-support.md) for exact generic CLI commands, pagination, and guarded file reads.

### 5. Treat writes as explicit and preview-first

For `POST`, `PATCH`, `PUT`, or `DELETE`:

1. Run with `-DryRun` first.
2. Summarize the exact method, URL, query, and body that would be sent.
3. Only perform the live request when the user explicitly wants the mutation.
4. Add `-AllowWrite` to the second run.

The wrapper refuses live writes unless `-AllowWrite` is present.

Use `-JsonPatch` only for work item patch payloads.

### 6. Handle conditional and route-limited areas honestly

- `release` is conditional. Run `Test-AzureDevOpsServerConnection.ps1 -CheckReleaseArea` first and use `-AllowConditionalArea` only after the probe succeeds.
- `search` is conditional. Run `Test-AzureDevOpsServerConnection.ps1 -CheckSearchArea` first. Set `AZURE_DEVOPS_SERVER_SEARCH_BASE_URL` when the deployment uses a dedicated search host.
- `testresults` is conditional. Run `Test-AzureDevOpsServerConnection.ps1 -CheckTestResultsArea` first. Set `AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL` when the deployment uses a dedicated test results host.
- Only explicitly allowlisted POST read routes bypass write gating.
- Deferred cloud-only domains must still fail clearly. Do not fake Azure DevOps Services parity.
- If the server behaves like an older or nonstandard TFS deployment, report that it is outside first-class support instead of guessing.

### 7. Escalate to references only when needed

- Auth choices or environment setup: [references/auth-and-configuration.md](references/auth-and-configuration.md)
- URL construction and resource-area caveats: [references/url-and-resource-areas.md](references/url-and-resource-areas.md)
- Version-selection guidance: [references/api-version-matrix.md](references/api-version-matrix.md)
- Common task recipes: [references/workflow-recipes.md](references/workflow-recipes.md)
- Team iterations, team settings, backlogs, and capacity: [references/work-support.md](references/work-support.md)
- Builds, timelines, artifacts, and queue previews: [references/build-support.md](references/build-support.md)
- Release definitions, releases, environments, and deployments: [references/release-support.md](references/release-support.md)
- Repositories, branches, and pull requests: [references/repo-support.md](references/repo-support.md)
- Work items, WIQL, saved queries, comments, and revisions: [references/work-item-support.md](references/work-item-support.md)
- Wikis and wiki pages: [references/wiki-support.md](references/wiki-support.md)
- Search routes and caveats: [references/search-support.md](references/search-support.md)
- Test plans, suites, and runs: [references/test-support.md](references/test-support.md)
- Build- and work-item-linked test results: [references/test-results-support.md](references/test-results-support.md)
