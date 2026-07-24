# Work Support

## Use This File For

- team iteration reads
- team settings reads
- backlog reads
- iteration and team capacity reads
- deciding which `work` routes are safe to use on Azure DevOps Server

This file covers the `work` domain that maps to planning metadata such as iterations, team settings, and capacity. It assumes the generic wrapper:

- `scripts/Invoke-AzureDevOpsServerApi.ps1`

and the local validated collection shape:

- `http://localhost:8081/DefaultCollection`

## Support Level

Treat `work` as a supported read domain for Azure DevOps Server when the target collection and project bootstrap succeed.

Common read routes:

- list team iterations
- get team settings
- list backlogs
- get iteration capacities
- get team capacity

Write routes like creating or assigning iterations are possible through the wrapper, but should remain preview-first and only run on explicit request.

## Discover The Team First

The default team name is often not the same as the project name. On the local server, project `test` uses team `test Team`.

List teams:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -ServerVersionHint 2020 `
  -Method GET `
  -Resource projects/test/teams
```

Use either the team name or the team ID in later `work` calls.

## Team Iterations

List iterations assigned to a specific team:

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

Current team only:

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

## Team Settings

Read team settings, including default iteration behavior:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -Team 'test Team' `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area work `
  -Resource teamsettings
```

## Backlogs

List backlogs for a team:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -Team 'test Team' `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area work `
  -Resource backlogs
```

On the local server this returned the standard Epic, Issue, and Task backlog categories.

## Capacity

Capacity routes are nested under
`teamsettings/iterations/{iterationId}/capacities`; omitting `teamsettings`
targets a controller that does not exist.

Get capacity for a specific iteration across the team:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -Team 'test Team' `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area work `
  -Resource teamsettings/iterations/<iteration-id>/capacities
```

Get capacity for a specific team member in an iteration:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -Team 'test Team' `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area work `
  -Resource teamsettings/iterations/<iteration-id>/capacities/<team-member-id>
```

Preview a capacity update without sending it:

```powershell
$body = @{
  activities = @(
    @{
      name = "Development"
      capacityPerDay = 6
    }
  )
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -Team 'test Team' `
  -ServerVersionHint 2020 `
  -Method PATCH `
  -Area work `
  -Resource teamsettings/iterations/<iteration-id>/capacities/<team-member-id> `
  -Body $body `
  -DryRun
```

Live write requires a second run with `-AllowWrite`.

## Write Safety

For `work` writes such as:

- create iterations
- assign team iterations
- update capacity

always:

1. run with `-DryRun`
2. verify the exact team, iteration, and member IDs
3. only then rerun with `-AllowWrite`

Do not mutate planning metadata just to test connectivity.

## Validated Locally

Validated against the local server shape:

- collection: `http://localhost:8081/DefaultCollection`
- project: `test`
- team: `test Team`
- team id: `fda2bb71-9c8d-4dff-a0f7-9daba81f9002`
- current iteration: `Sprint 1` (`46dfe5d8-9cb2-451b-a91f-6a2a55894db1`)

Reasonable local claims:

- project bootstrap succeeded
- the server supports authenticated `work` planning flows strongly enough to justify adding `work` as a first-class supported domain in the skill
- `teamsettings/iterations` returns the current iteration for the real default team
- `teamsettings` returns default iteration and working-day settings
- `backlogs` returns backlog metadata for the real default team

Not yet claimed here:

- a capacity route returned non-empty results
- any `work` write route was executed live

Treat those as follow-up smoke tests after the main skill integrates this domain.
