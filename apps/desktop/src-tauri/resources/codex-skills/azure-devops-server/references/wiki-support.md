# Wiki Support

## Use This File For

- listing wikis
- reading wiki pages
- batching wiki page reads
- previewing wiki mutations safely

## Support Level

`wiki` is supported.

Common route shapes:

- list wikis: area `wiki`, resource `wikis`
- read a page by path: area `wiki`, resource `wikis/{wikiIdentifier}/pages`
- batch page reads: area `wiki`, resource `wikis/{wikiIdentifier}/pagesbatch`

## List Wikis

Collection-scoped:

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area wiki `
  -Resource wikis
```

## Read One Wiki Page

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method GET `
  -Area wiki `
  -Project Fabrikam `
  -Resource wikis/Fabrikam.wiki/pages `
  -Query @{ path = '/Home'; includeContent = 'true' }
```

## Batch Read Wiki Pages

`wiki/wikis/{wikiIdentifier}/pagesbatch` is treated as a safe read route even though it uses `POST`.

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

## Preview A Wiki Write

Live wiki writes still require the normal preview-first write gate.

```powershell
$body = @{
  content = '# Updated page'
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -Method PUT `
  -Area wiki `
  -Project Fabrikam `
  -Resource wikis/Fabrikam.wiki/pages `
  -Query @{ path = '/Runbook/Updated' } `
  -Body $body `
  -DryRun
```

## Notes

- `wiki/wikis` stays collection-scoped in this wrapper even when a default project is configured.
- Use `-Project` for project wiki routes such as wiki page reads and writes.
- If the target server returns `404`, confirm the wiki feature is enabled and the wiki identifier is correct.
- Keep live edits behind `-DryRun` followed by an explicit `-AllowWrite` run.
