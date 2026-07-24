# Search Support

## Use This File For

- work item search
- code search
- wiki search
- understanding search-specific caveats on Azure DevOps Server

## Support Level

`search` is conditional.

Why conditional:

- Azure DevOps Server search availability depends on the server installation and indexing state
- Microsoft Learn search examples for Azure DevOps Services often use service-specific hosts
- this toolkit can use `AZURE_DEVOPS_SERVER_SEARCH_BASE_URL` when the deployment exposes search on a dedicated host

## Probe Search Support First

```powershell
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 `
  -Project Fabrikam `
  -CheckSearchArea
```

This probe exercises a representative search route. A failed probe can mean the route, base URL, search indexing, auth, or `api-version` needs adjustment; it is not a guarantee that every search route is absent.

If the deployment exposes search on a dedicated host, set:

```powershell
$env:AZURE_DEVOPS_SERVER_SEARCH_BASE_URL = "https://ado-search-server/tfs/DefaultCollection"
```

## Search Work Items

`search/workitemsearchresults` is treated as a safe read route even though it uses `POST`.

```powershell
$body = @{
  searchText = "active bug"
  '$top' = 25
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method POST `
  -Area search `
  -Project Fabrikam `
  -Resource workitemsearchresults `
  -Body $body `
  -AllowConditionalArea
```

## Search Code

```powershell
$body = @{
  searchText = "TODO"
  '$top' = 25
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method POST `
  -Area search `
  -Project Fabrikam `
  -Resource codesearchresults `
  -Body $body `
  -AllowConditionalArea
```

## Search Wiki Pages

```powershell
$body = @{
  searchText = "deployment"
  '$top' = 25
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method POST `
  -Area search `
  -Project Fabrikam `
  -Resource wikisearchresults `
  -Body $body `
  -AllowConditionalArea
```

## Notes

- `searchPlatformConnectionString is invalid` is a server-side Search configuration failure. Changing the route or `api-version` does not repair it; configure the Azure DevOps Server Search service or point `AZURE_DEVOPS_SERVER_SEARCH_BASE_URL` at the working Search endpoint.

- If the server responds with `404`, search may not be installed or exposed on that deployment.
- If the server responds with `400` or `401`, verify the area availability, auth mode, base URL override, and `api-version`.
- Keep Azure DevOps Services-only hostnames out of hand-built server URLs; let the wrapper and probes surface what the target server actually accepts.
