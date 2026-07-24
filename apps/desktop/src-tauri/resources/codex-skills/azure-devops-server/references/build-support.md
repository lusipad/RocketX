# Build Support

## Use This File For

- listing build definitions
- listing builds and filtering by status or definition
- reading one build
- reading build timeline, logs, and artifacts
- previewing build queue requests safely

## Support Level

`build` is supported.

These routes typically stay project-scoped.

## List Build Definitions

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource definitions `
  -Query @{ '$top' = 25 }
```

## Read One Build Definition

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource definitions/12
```

## List Builds

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource builds `
  -Query @{
    '$top' = 10
    statusFilter = 'completed'
  }
```

## List Builds For One Definition

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource builds `
  -Query @{
    definitions = 12
    '$top' = 10
  }
```

## Read One Build

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource builds/123
```

## Read Build Timeline

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource builds/123/timeline
```

## List Build Logs

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource builds/123/logs
```

## List Build Artifacts

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area build `
  -Project Fabrikam `
  -Resource builds/123/artifacts
```

## Preview Queueing A Build

Build queue requests are live writes and stay behind the normal preview-first gate.

```powershell
$body = @{
  definition = @{
    id = 12
  }
  sourceBranch = "refs/heads/main"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method POST `
  -Area build `
  -Project Fabrikam `
  -Resource builds `
  -Body $body `
  -DryRun
```

## Notes

- Use build definition IDs when names are duplicated or unstable.
- Build logs and artifacts can be large; start by listing metadata before attempting deeper inspection.
- Keep queue/build-start operations behind `-DryRun`, then add `-AllowWrite` only when the user explicitly wants the mutation.
