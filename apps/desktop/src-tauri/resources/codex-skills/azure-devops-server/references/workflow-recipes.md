# Workflow Recipes

## Use This File For

- common read-only tasks
- dry-run-first write patterns
- supported wrapper shapes
- quick links into the detailed domain references

All examples assume you already set:

- `AZURE_DEVOPS_SERVER_COLLECTION_URL`
- `AZURE_DEVOPS_SERVER_AUTH_MODE`
- `AZURE_DEVOPS_SERVER_PAT` when using `pat`
- `AZURE_DEVOPS_SERVER_PROJECT` when you want a default project
- `AZURE_DEVOPS_SERVER_TEAM` when you want a default team for `work` routes

Domain references:

- repository, branches, and pull requests: [repo-support.md](repo-support.md)
- work items, WIQL, saved queries, comments, revisions: [work-item-support.md](work-item-support.md)
- team settings, iterations, backlogs, capacity: [work-support.md](work-support.md)
- builds, timelines, artifacts, and queue previews: [build-support.md](build-support.md)
- release definitions, releases, environments, and deployments: [release-support.md](release-support.md)
- wikis and wiki pages: [wiki-support.md](wiki-support.md)
- search routes: [search-support.md](search-support.md)
- test plans, suites, and runs: [test-support.md](test-support.md)
- build-linked test result routes: [test-results-support.md](test-results-support.md)

## List Projects

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Resource projects `
  -Query @{ '$top' = 50 }
```

## List Repositories In A Project

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area git `
  -Project Fabrikam `
  -Resource repositories
```

## List Teams In A Project

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Resource 'projects/Fabrikam/teams'
```

## Read One Work Item

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area wit `
  -Resource workitems/12345 `
  -Query @{ '$expand' = 'relations' }
```

## Run WIQL

```powershell
$body = @{
  query = "Select [System.Id], [System.Title], [System.State] From WorkItems Where [System.AssignedTo] = @Me And [System.WorkItemType] = 'Bug' And [System.State] <> 'Closed'"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method POST `
  -Area wit `
  -Project Fabrikam `
  -Resource wiql `
  -Body $body
```

`wit/wiql` is a safe read route even though it uses `POST`, so the wrapper allows a live call without `-AllowWrite`.

## List Team Iterations

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area work `
  -Project Fabrikam `
  -Team 'Fabrikam Team' `
  -Resource teamsettings/iterations
```

## Read Team Settings

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area work `
  -Project Fabrikam `
  -Team 'Fabrikam Team' `
  -Resource teamsettings
```

## List Builds

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource builds `
  -Query @{ '$top' = 10; statusFilter = 'completed' }
```

## List Build Definitions

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource definitions `
  -Query @{ '$top' = 25 }
```

## List Pull Requests

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area git `
  -Project Fabrikam `
  -Resource repositories/MyRepo/pullrequests `
  -Query @{ 'searchCriteria.status' = 'active'; '$top' = 20 }
```

## List Wikis

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area wiki `
  -Resource wikis
```

## Batch Read Wiki Pages

```powershell
$body = @{
  top = 20
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method POST `
  -Area wiki `
  -Project Fabrikam `
  -Resource wikis/Fabrikam.wiki/pagesbatch `
  -Body $body
```

`wiki/wikis/{wikiIdentifier}/pagesbatch` is treated as a safe read route even though it uses `POST`.

## Search Work Items

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

`search/workitemsearchresults` is treated as a safe read route even though it uses `POST`.

## List Test Plans

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area testplan `
  -Project Fabrikam `
  -Resource plans
```

## List Test Runs

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area test `
  -Project Fabrikam `
  -Resource runs `
  -Query @{ '$top' = 20 }
```

## Read Test Results For A Run

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area test `
  -Project Fabrikam `
  -Resource runs/123/results
```

## Query Build-Linked Test Result Summary

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

## Probe Release Support

```powershell
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 `
  -Project Fabrikam `
  -CheckReleaseArea
```

Offline preview only:

```powershell
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 `
  -Project Fabrikam `
  -CheckReleaseArea `
  -DryRun
```

Only if that probe reports `ReleaseAreaStatus = available`:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area release `
  -Project Fabrikam `
  -Resource definitions `
  -Query @{ '$top' = 10 } `
  -AllowConditionalArea
```

## List Releases

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area release `
  -Project Fabrikam `
  -Resource releases `
  -Query @{ '$top' = 20 } `
  -AllowConditionalArea
```

## Preview A Work Item Patch

```powershell
$patch = @(
  @{
    op = "add"
    path = "/fields/System.Title"
    value = "Example title"
  }
)

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method PATCH `
  -Area wit `
  -Resource workitems/12345 `
  -Body $patch `
  -JsonPatch `
  -DryRun
```

Live patch:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method PATCH `
  -Area wit `
  -Resource workitems/12345 `
  -Body $patch `
  -JsonPatch `
  -AllowWrite
```

## Conditional Areas

- `release` remains conditional and still requires a successful probe plus `-AllowConditionalArea`.
- `search` remains conditional because host layout and indexing vary by installation.
- `testresults` remains conditional because some server deployments expose it differently from the collection root.
- Only explicitly allowlisted POST read routes bypass write gating.
