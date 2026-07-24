# Release Support

## Use This File For

- probing whether the release area exists on the target server
- listing release definitions
- listing releases
- inspecting release environments and deployments
- previewing release mutations safely

## Support Level

`release` is conditional.

Why conditional:

- Azure DevOps Server deployments do not all expose the release area
- authorization and installed components can vary per collection
- the skill requires an explicit probe before live release routes are treated as available

## Probe Release Support First

```powershell
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 `
  -Project Fabrikam `
  -CheckReleaseArea
```

Dry-run preview:

```powershell
pwsh -File .\scripts\Test-AzureDevOpsServerConnection.ps1 `
  -Project Fabrikam `
  -CheckReleaseArea `
  -DryRun
```

Only use `-AllowConditionalArea` after the probe succeeds.

## List Release Definitions

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area release `
  -Project Fabrikam `
  -Resource definitions `
  -Query @{ '$top' = 20 } `
  -AllowConditionalArea
```

## Read One Release Definition

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area release `
  -Project Fabrikam `
  -Resource definitions/15 `
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

## Read One Release

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area release `
  -Project Fabrikam `
  -Resource releases/42 `
  -AllowConditionalArea
```

## Read Release Environments

The release payload already contains its `environments` array. There is no
`releases/{releaseId}/environments` list route. Read the release and inspect that array:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area release `
  -Project Fabrikam `
  -Resource releases/42 `
  -AllowConditionalArea
```

To read one environment directly, append its ID:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area release `
  -Project Fabrikam `
  -Resource releases/42/environments/7 `
  -AllowConditionalArea
```

## List Deployments

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area release `
  -Project Fabrikam `
  -Resource deployments `
  -Query @{ '$top' = 20 } `
  -AllowConditionalArea
```

## Preview Creating A Release

Release creation is a live write and stays behind the normal preview-first gate.

```powershell
$body = @{
  definitionId = 15
  description = "Preview release creation"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method POST `
  -Area release `
  -Project Fabrikam `
  -Resource releases `
  -Body $body `
  -AllowConditionalArea `
  -DryRun
```

## Notes

- The release area can be present on one server and absent on another; keep the probe in front of live use.
- Use definition and release IDs when names are ambiguous.
- Treat deployment-start and release-creation calls as explicit mutations that require `-DryRun` followed by `-AllowWrite`.
