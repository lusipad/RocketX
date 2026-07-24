# Repository Support

## Use This File For

- repository and branch reads on Azure DevOps Server
- pull request read routes and write-preview patterns
- directory listing and file content reads through the generic wrapper
- understanding what this skill supports vs the Azure DevOps Services MCP

## Scope And Boundary

This skill supports the Azure DevOps Server `git` area through `Invoke-AzureDevOpsServerApi.ps1`. It is a PowerShell-wrapper workflow, not a full clone of the Azure DevOps Services MCP.

Use it for:

- listing repositories in a project
- reading repository metadata
- listing branch refs
- listing and reading pull requests
- previewing and creating pull requests when the user explicitly wants the mutation
- previewing branch creation through `refs`
- listing directories and reading file content when the repository has at least one branch or commit

Do not claim Azure DevOps Services parity. This skill does not try to mirror every cloud-only repo tool, comment-thread helper, or identity convenience flow from the official MCP.

## Validated Local Shape

These routes were validated locally against:

- collection: `http://localhost:8081/DefaultCollection`
- project: `test`
- repository: `test`
- branch: `main`
- live draft PR: `pullRequestId = 1`

Reusable rule:

- replace `http://localhost:8081/DefaultCollection` with your collection URL
- replace `test` with your project and repository names or IDs
- prefer repository IDs when names are ambiguous

## Supported Read Routes

### List Repositories In A Project

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories
```

### Read One Repository

```powershell
pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test
```

### List Branches

Branch reads use `refs` with a `heads/` filter:

```powershell
$query = @{
  filter = "heads/"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test/refs `
  -Query $query
```

### List Pull Requests

```powershell
$query = @{
  "searchCriteria.status" = "active"
  '$top' = 20
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test/pullrequests `
  -Query $query
```

To read a single PR, switch to:

- `repositories/{repoIdOrName}/pullrequests/{pullRequestId}`

## Fixed-Snapshot Pull Request Evidence

Use the generic wrapper for each explicit PR ID:

```powershell
$api = ".\scripts\Invoke-AzureDevOpsServerApi.ps1"
$pr = & $api -Method GET -Area git -Resource "pullrequests/123" `
  -Query @{ includeCommits = "true"; includeWorkItemRefs = "true" }

$project = $pr.repository.project.name
$repoId = $pr.repository.id
$iterations = & $api -Method GET -Area git -Project $project `
  -Resource "repositories/$repoId/pullRequests/123/iterations" `
  -Query @{ includeCommits = "true" }
$iteration = @($iterations.value | Sort-Object -Property { [int]$_.id } -Descending)[0]

$changes = & $api -Method GET -Area git -Project $project `
  -Resource "repositories/$repoId/pullRequests/123/iterations/$($iteration.id)/changes" `
  -Query @{ '$compareTo' = 0; '$skip' = 0; '$top' = 100 }
```

Follow `nextSkip` and `nextTop` until the server stops returning them or 500 entries are collected. Use `commonRefCommit.commitId` as the before side and `sourceRefCommit.commitId` as the after side. `targetRefCommit` is target-snapshot metadata, not the merge base. For renamed or deleted files, use `originalPath` on the before side.

Before reading content, request item and blob metadata at the pinned commit:

```powershell
$itemQuery = @{
  path = "/src/example.cs"
  includeContent = "false"
  includeContentMetadata = "true"
  '$format' = "json"
  "versionDescriptor.version" = $iteration.sourceRefCommit.commitId
  "versionDescriptor.versionType" = "commit"
}
$item = & $api -Method GET -Area git -Project $project `
  -Resource "repositories/$repoId/items" -Query $itemQuery
$blob = & $api -Method GET -Area git -Project $project `
  -Resource "repositories/$repoId/blobs/$($item.objectId)" `
  -Query @{ '$format' = "json" }
```

Only repeat the Items request with `includeContent = "true"` when the path is not a folder, `contentMetadata.isBinary` is false, and `blob.size` is a valid non-negative integer no greater than 256 KiB. Missing or invalid size metadata must fail closed. `$format=json` is required because some Server deployments otherwise return the blob body instead of metadata.

Keep each comparison within 20 file reads and 1 MiB of returned text. Do not clone the repository or perform PR writes. If content cannot be read, label the conclusion as based only on metadata and the change list.

## Dry-Run-First Write Routes

For repository writes, always do this sequence:

1. Run the request with `-DryRun`.
2. Check the emitted method, URI, query, and serialized body.
3. Only then re-run the same command with `-AllowWrite`.

The wrapper blocks live writes unless `-AllowWrite` is present.

### Preview Pull Request Creation

```powershell
$body = @{
  sourceRefName = "refs/heads/feature/example"
  targetRefName = "refs/heads/main"
  title = "Example PR from wrapper"
  description = "Dry-run preview only."
  isDraft = $true
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method POST `
  -Area git `
  -Resource repositories/test/pullrequests `
  -Body $body `
  -DryRun
```

The preview shape is:

- method: `POST`
- route: `git/repositories/{repo}/pullrequests`
- required fields: `sourceRefName`, `targetRefName`, `title`
- common optional fields: `description`, `isDraft`, reviewer/work-item fields if the target server supports them

This flow was also validated end-to-end locally by pushing a temporary feature branch and creating draft PR `1` against `main`.

### Preview Pull Request Update

Use `PATCH` against a PR ID. Keep the body minimal and only send fields you intend to change.

```powershell
$body = @{
  title = "Retitled PR"
  description = "Updated from preview"
  status = "active"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method PATCH `
  -Area git `
  -Resource repositories/test/pullrequests/123 `
  -Body $body `
  -DryRun
```

Typical update fields:

- `title`
- `description`
- `status`
- `isDraft`
- `targetRefName`

### Preview Branch Creation

Branch creation on Server uses `POST` to `refs` with a ref-update array.

```powershell
$body = @(
  @{
    name = "refs/heads/feature/example"
    oldObjectId = "0000000000000000000000000000000000000000"
    newObjectId = "<source-commit-id>"
  }
)

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method POST `
  -Area git `
  -Resource repositories/test/refs `
  -Body $body `
  -DryRun
```

Notes:

- `oldObjectId` must be all zeroes for a new branch
- `newObjectId` must be a real source commit ID
- if the repository is empty, branch creation cannot succeed until there is an initial commit

## Directory Listing And File Content Reads

Use the `items` route for repository browsing and file reads. On Azure DevOps Server, these calls depend on an existing branch or commit. On the local server, `items` works against `main` even though the repository detail payload still reports `size = 0`, so do not rely on `size` alone to decide whether content reads are possible.

### List A Directory

```powershell
$query = @{
  scopePath = "/"
  recursionLevel = "OneLevel"
  includeContentMetadata = "true"
  "versionDescriptor.version" = "main"
  "versionDescriptor.versionType" = "branch"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test/items `
  -Query $query
```

### Read File Content

```powershell
$query = @{
  path = "/README.md"
  includeContent = "true"
  "versionDescriptor.version" = "main"
  "versionDescriptor.versionType" = "branch"
}

pwsh -File .\scripts\Invoke-AzureDevOpsServerApi.ps1 `
  -CollectionUrl http://localhost:8081/DefaultCollection `
  -Project test `
  -ServerVersionHint 2020 `
  -Method GET `
  -Area git `
  -Resource repositories/test/items `
  -Query $query
```

If `items` returns `404` or `400` on Server, check:

- the repository has at least one real branch or commit
- the branch or commit exists
- the path is correct
- the route is project-scoped and uses the expected `git` area

## Practical Boundary Vs Azure DevOps Services MCP

The official Azure DevOps MCP exposes a broader repositories surface, including richer pull-request thread and reviewer helpers. This server skill intentionally keeps repository support narrower:

- use the generic REST wrapper instead of a large tool catalog
- prefer previewable raw routes over hidden client-library behavior
- keep writes explicit with `-DryRun` and `-AllowWrite`
- report unsupported or server-specific gaps instead of inventing cloud behavior
