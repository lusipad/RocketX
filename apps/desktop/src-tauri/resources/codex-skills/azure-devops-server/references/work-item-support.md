# Work Item Support

## Use This File For

- work item reads on Azure DevOps Server
- WIQL and saved query execution
- comments and revisions read patterns
- iteration reads and backlog fallbacks
- preview-first JSON Patch create and update flows

Examples use the locally validated shape:

- collection: `http://localhost:8081/DefaultCollection`
- project: `test`
- server hint: `2020`

Replace those values for other servers.

## Read One Work Item

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area wit `
  -Resource workitems/12345 `
  -Query @{ '$expand' = 'relations' }
```

## Read Multiple Work Items By ID

Use the `workitems` route with a comma-separated `ids` list.

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area wit `
  -Resource workitems `
  -Query @{
    ids = '12345,12346'
    fields = 'System.Id,System.WorkItemType,System.Title,System.State'
    errorPolicy = 'omit'
  }
```

## Run WIQL

`WIQL` is a safe read route. This wrapper allows live `POST` to `wit/wiql` without `-AllowWrite`.

```powershell
$body = @{
  query = "Select [System.Id], [System.Title], [System.State] From WorkItems Where [System.TeamProject] = 'test' Order By [System.ChangedDate] Desc"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method POST `
  -Area wit `
  -Resource wiql `
  -Body $body `
  -DryRun
```

For the live read, keep the same command and remove `-DryRun`.

## Batch Read Caveat

Some Azure DevOps Services tooling uses `wit/workitemsbatch` for multi-item reads. On the local Azure DevOps Server 2020 target, `wit/workitemsbatch` returned `404`, so this skill does not treat it as first-class support.

For stable Azure DevOps Server reads, prefer:

- `GET wit/workitems?ids=...`
- `POST wit/wiql` when the selection logic is query-shaped

## Saved Queries

List query roots:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area wit `
  -Resource queries
```

Read a query folder or tree:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area wit `
  -Resource 'queries/Shared Queries' `
  -Query @{ '$depth' = 2 }
```

Run a saved query by ID. The query metadata exposes a `_links.wiql` URL; in this wrapper the reusable shape is `wit/wiql/{queryId}`:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area wit `
  -Resource 'wiql/9acea7f9-f867-4dc6-8d98-fd0436a41bec'
```

## Comments And Revisions

Canonical comments route for Azure DevOps Server 2020:
`wit/workitems/{workItemId}/comments?api-version=6.0-preview.3`.

List comments for a work item:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area wit `
  -Resource workitems/12345/comments `
  -ApiVersion 6.0-preview.3
```

List revisions:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area wit `
  -Resource workitems/12345/revisions `
  -Query @{ '$top' = 20 }
```

Notes:

- comments support can vary by server version and `api-version`
- the comments route is preview-versioned on Azure DevOps Server 2020; a plain `6.0` request returns `VssInvalidPreviewVersionException`
- if comments still return 404 or 400 with a compatible preview version while core WIT reads work, keep comments as best-effort for that server instead of inventing a cloud-only path

## Iteration Reads And Backlog Fallbacks

Read iterations from the `work` area:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -Team 'test Team' `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area work `
  -Resource teamsettings/iterations
```

Current iteration only:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -Team 'test Team' `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area work `
  -Resource teamsettings/iterations `
  -Query @{ '$timeframe' = 'current' }
```

`work/backlogs` is less uniform on Server than basic `wit` routes. If backlog endpoints 404 on a target, fall back to WIQL or a saved query scoped by iteration, type, and priority:

```powershell
$body = @{
  query = "Select [System.Id], [System.Title], [Microsoft.VSTS.Common.Priority] From WorkItems Where [System.TeamProject] = 'test' And [System.IterationPath] Under 'test\\Sprint 1' Order By [Microsoft.VSTS.Common.Priority] Asc"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method POST `
  -Area wit `
  -Resource wiql `
  -Body $body `
  -DryRun
```

## Preview-First JSON Patch

Create a work item preview:

```powershell
$patch = @(
  @{ op = 'add'; path = '/fields/System.Title'; value = 'Preview task' },
  @{ op = 'add'; path = '/fields/System.Description'; value = 'Created from the server wrapper preview flow.' }
)

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method POST `
  -Area wit `
  -Resource 'workitems/$Task' `
  -Body $patch `
  -JsonPatch `
  -DryRun
```

Update a work item preview:

```powershell
$patch = @(
  @{ op = 'add'; path = '/fields/System.Title'; value = 'Preview title change' },
  @{ op = 'add'; path = '/fields/System.History'; value = 'Preview-only update from the wrapper.' }
)

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method PATCH `
  -Area wit `
  -Resource workitems/12345 `
  -Body $patch `
  -JsonPatch `
  -DryRun
```

For the live call, keep the same payload, remove `-DryRun`, and add `-AllowWrite`.

## Safe Write Guidance

- use `-DryRun` before every `POST`, `PATCH`, `PUT`, or `DELETE`
- expect live writes to fail unless `-AllowWrite` is present, except for the safe read `POST` route `wit/wiql`
- keep JSON Patch payloads small and explicit
- preview the exact work item type or ID before running a live mutation

## Validated Locally

Validated against:

- `http://localhost:8081/DefaultCollection`
- project `test`
- `ServerVersionHint 2020`

Confirmed locally:

- `wit/wiql` works for live WIQL execution without `-AllowWrite`
- `wit/queries` and `wit/queries/{pathOrId}` work for saved-query metadata
- `wit/wiql/{queryId}` works for saved-query results
- `work/teamsettings/iterations` works for iteration reads when a real team name or ID is supplied

Not confirmed with non-empty local data:

- a direct `GET wit/workitems/{id}` succeeded against a real work item ID
- comments and revisions returned against a real work item ID
