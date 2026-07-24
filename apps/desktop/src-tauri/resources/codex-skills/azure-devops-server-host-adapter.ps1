[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertTo-HashtableValue {
    param([Parameter(Mandatory)] $Value)

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $table = @{}
        foreach ($entry in $Value.GetEnumerator()) {
            $table[[string]$entry.Key] = ConvertTo-HashtableValue -Value $entry.Value
        }
        return $table
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        $items = New-Object System.Collections.Generic.List[object]
        foreach ($item in $Value) {
            $items.Add((ConvertTo-HashtableValue -Value $item))
        }
        return ,$items.ToArray()
    }

    return $Value
}

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) {
    throw "RocketX Azure DevOps Server runner expected one JSON object on stdin."
}

$request = ConvertFrom-Json -InputObject $raw -AsHashtable -Depth 100
if (-not $request.ContainsKey("resource")) {
    throw "RocketX Azure DevOps Server runner requires a resource."
}

$scriptPath = Join-Path -Path $PSScriptRoot -ChildPath "azure-devops-server/scripts/Invoke-AzureDevOpsServerApi.ps1"
$invokeParams = @{
    Method   = "GET"
    Resource = [string]$request.resource
}

$fieldMap = @{
    area               = "Area"
    project            = "Project"
    team               = "Team"
    collectionUrl      = "CollectionUrl"
    authMode           = "AuthMode"
    pat                = "Pat"
    apiVersion         = "ApiVersion"
    serverVersionHint  = "ServerVersionHint"
}

foreach ($entry in $fieldMap.GetEnumerator()) {
    if (-not $request.ContainsKey($entry.Key)) {
        continue
    }

    $value = $request[$entry.Key]
    if ($value -is [string] -and [string]::IsNullOrWhiteSpace($value)) {
        continue
    }

    if ($null -ne $value) {
        $invokeParams[$entry.Value] = $value
    }
}

if ($request.ContainsKey("query") -and $null -ne $request.query) {
    $invokeParams.Query = ConvertTo-HashtableValue -Value $request.query
}

if ($request.ContainsKey("allowConditionalArea") -and $request.allowConditionalArea) {
    $invokeParams.AllowConditionalArea = $true
}

$result = & $scriptPath @invokeParams
$result | ConvertTo-Json -Depth 100 -Compress
