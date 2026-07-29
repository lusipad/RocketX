[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) {
    throw "RocketX Azure DevOps Server runner expected one JSON object on stdin."
}

$requestObject = ConvertFrom-Json -InputObject $raw
$request = @{}
foreach ($property in $requestObject.PSObject.Properties) {
    if ($property.Name -eq "query" -and $null -ne $property.Value) {
        $query = @{}
        foreach ($queryProperty in $property.Value.PSObject.Properties) {
            $queryValue = $queryProperty.Value
            if ($queryValue -is [System.Collections.IEnumerable] -and -not ($queryValue -is [string])) {
                $query[[string]$queryProperty.Name] = @($queryValue)
            } else {
                $query[[string]$queryProperty.Name] = $queryValue
            }
        }
        $request[[string]$property.Name] = $query
        continue
    }
    $request[[string]$property.Name] = $property.Value
}
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
    $invokeParams.Query = $request.query
}

if ($request.ContainsKey("allowConditionalArea") -and $request.allowConditionalArea) {
    $invokeParams.AllowConditionalArea = $true
}

$result = & $scriptPath @invokeParams
$result | ConvertTo-Json -Depth 100 -Compress
