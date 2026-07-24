# Test Support

## Use This File For

- test plan listing
- suite inspection
- test run inspection
- test result reads from the `test` area

## Support Level

- `testplan` is supported
- `test` is supported

These routes typically stay project-scoped.

## List Test Plans

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area testplan `
  -Project Fabrikam `
  -Resource plans
```

## List Suites In A Plan

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area testplan `
  -Project Fabrikam `
  -Resource plans/12/suites
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

## Read Results For One Test Run

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area test `
  -Project Fabrikam `
  -Resource runs/123/results
```

## Notes

- Prefer `testplan` for planning constructs such as plans and suites.
- Prefer `test` for execution constructs such as runs and run-scoped results.
- If a newer endpoint needs a newer `api-version`, set `AZURE_DEVOPS_SERVER_API_VERSION` explicitly instead of assuming cloud defaults.
