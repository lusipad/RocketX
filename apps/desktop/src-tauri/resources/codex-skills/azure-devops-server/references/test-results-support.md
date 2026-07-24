# Test Results Support

## Use This File For

- build-linked test result summaries
- test result work item flows
- understanding `testresults` area caveats

## Support Level

`testresults` is conditional.

Why conditional:

- Microsoft Learn examples for some `testresults` APIs use service-specific hosts
- some commonly used endpoints are preview-heavy or build-specific
- this toolkit can use `AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL` when the deployment exposes test results on a dedicated host

## Probe Test Results Support First

```powershell
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 `
  -Project Fabrikam `
  -CheckTestResultsArea
```

This probe exercises a representative `testresults` route with the preview version required by that resource. A failed probe can mean the route, base URL, auth, or feature configuration needs adjustment; it is not a guarantee that every `testresults` endpoint is absent.

If the deployment exposes test results on a dedicated host, set:

```powershell
$env:AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL = "https://ado-testresults-server/tfs/DefaultCollection"
```

## Query A Build Summary

Some `testresults` endpoints are documented with preview API versions. On Azure DevOps Server, prefer an explicit override only after confirming the target server version.
The canonical route used here is
`resultsummarybybuild?buildId={buildId}&api-version=7.0-preview.1`.

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area testresults `
  -Project Fabrikam `
  -Resource resultsummarybybuild `
  -Query @{ buildId = 123 } `
  -ApiVersion 7.0-preview.1 `
  -AllowConditionalArea
```

## Query Result-Linked Work Items

Use the run/result-scoped route
`runs/{runId}/results/{resultId}/workitems?api-version=7.0-preview.2`.

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area testresults `
  -Project Fabrikam `
  -Resource runs/123/results/456/workitems `
  -ApiVersion 7.0-preview.2 `
  -AllowConditionalArea
```

## Notes

- For Azure DevOps Server, keep using the wrapper and configured base URLs instead of hand-copying Azure DevOps Services hosts.
- If a route returns `404`, verify that the target server version and `api-version` actually expose that endpoint before widening support claims.
- Keep write operations behind the same `-DryRun` plus `-AllowWrite` safety model as the rest of the toolkit.
