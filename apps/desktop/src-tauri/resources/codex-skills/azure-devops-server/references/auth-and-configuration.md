# Auth And Configuration

## Use This File For

- choosing between `pat` and `default-credentials`
- setting the minimum environment variables before running the helper scripts
- understanding why this skill does not use Azure DevOps Services auth flows

## Supported Auth Modes

### `default-credentials`

Use this first on Windows hosts that already have integrated access to Azure DevOps Server.

Good fit:

- domain-joined workstation
- interactive admin shell
- on-prem server access with Windows authentication

Tradeoff:

- strongest fit for local Windows environments
- weakest fit for cross-platform automation

### `pat`

Use this for ad hoc scripts, controlled automation, and cases where integrated credentials are unavailable.

Set:

```powershell
$env:AZURE_DEVOPS_SERVER_AUTH_MODE = "pat"
$env:AZURE_DEVOPS_SERVER_PAT = "<token>"
```

The helper converts the PAT into a Basic auth header using the standard `:<PAT>` form.

## Why Not Entra ID Or Azure CLI

Microsoft's authentication guidance says OAuth 2.0 and Microsoft Entra ID are Azure DevOps Services-only and that on-prem Azure DevOps Server scenarios should use .NET client libraries, Windows authentication, or personal access tokens.

This skill therefore keeps v1 to:

- `default-credentials`
- `pat`

## Required Inputs

Set at least:

```powershell
$env:AZURE_DEVOPS_SERVER_COLLECTION_URL = "https://ado-server/tfs/DefaultCollection"
```

Optional defaults:

```powershell
$env:AZURE_DEVOPS_SERVER_PROJECT = "Fabrikam"
$env:AZURE_DEVOPS_SERVER_TEAM = "Fabrikam Team"
$env:AZURE_DEVOPS_SERVER_API_VERSION = "6.0"
$env:AZURE_DEVOPS_SERVER_SERVER_VERSION = "2020"
$env:AZURE_DEVOPS_SERVER_SEARCH_BASE_URL = "https://ado-search-server/tfs/DefaultCollection"
$env:AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL = "https://ado-testresults-server/tfs/DefaultCollection"
```

Notes:

- `AZURE_DEVOPS_SERVER_PROJECT` is a default for project-scoped routes
- `AZURE_DEVOPS_SERVER_TEAM` is a default for team-scoped `work` routes
- `AZURE_DEVOPS_SERVER_API_VERSION` is honored by both helper scripts unless a per-command `-ApiVersion` override is passed
- `AZURE_DEVOPS_SERVER_SEARCH_BASE_URL` is only needed when the server exposes search on a dedicated host
- `AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL` is only needed when the server exposes test results on a dedicated host
- collection-scoped routes like `projects` or `projects/{project}/teams` do not use the default project/team path prefix

If `AZURE_DEVOPS_SERVER_COLLECTION_URL` is missing, the scripts also accept:

- `SYSTEM_TEAMFOUNDATIONCOLLECTIONURI`
- `SYSTEM_TEAMPROJECT`

## Recommended Startup Sequence

1. Set `AZURE_DEVOPS_SERVER_COLLECTION_URL`.
2. Set `AZURE_DEVOPS_SERVER_AUTH_MODE`.
3. Set `AZURE_DEVOPS_SERVER_PAT` when auth mode is `pat`.
4. Run:

```powershell
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1
```

5. Only after bootstrap succeeds, run the task-specific wrapper commands from [workflow-recipes.md](workflow-recipes.md).

## Notes

- If the target is actually Azure DevOps Services, prefer the official Azure DevOps MCP flow instead of this skill.
- If the task needs deep SDK coverage or complicated server-specific behavior, escalate to .NET client libraries instead of overextending the generic REST wrapper.
