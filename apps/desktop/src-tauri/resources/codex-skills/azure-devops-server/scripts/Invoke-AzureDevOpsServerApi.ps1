[CmdletBinding()]
param(
    [ValidateSet("GET", "POST", "PUT", "PATCH", "DELETE")]
    [string]$Method = "GET",
    [string]$Area,
    [Parameter(Mandatory)]
    [string]$Resource,
    [string]$Project,
    [string]$Team,
    [hashtable]$Query,
    [object]$Body,
    [string]$CollectionUrl,
    [ValidateSet("pat", "default-credentials")]
    [string]$AuthMode,
    [string]$Pat,
    [string]$ApiVersion,
    [ValidateSet("current", "20.0", "2022.1", "2022", "2020", "2019", "2018", "2017", "2015", "legacy")]
    [string]$ServerVersionHint,
    [string]$SearchBaseUrl,
    [string]$TestResultsBaseUrl,
    [switch]$AllowConditionalArea,
    [switch]$DryRun,
    [switch]$JsonPatch,
    [switch]$AllowWrite
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$modulePath = Join-Path -Path $PSScriptRoot -ChildPath "AzureDevOpsServer.psm1"
Import-Module $modulePath -DisableNameChecking -Force

$invokeParams = @{}
foreach ($entry in $PSBoundParameters.GetEnumerator()) {
    if ($entry.Value -is [string] -and [string]::IsNullOrWhiteSpace($entry.Value)) {
        continue
    }

    $invokeParams[$entry.Key] = $entry.Value
}

Invoke-AzureDevOpsServerRequest @invokeParams
