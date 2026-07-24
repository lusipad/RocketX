Set-StrictMode -Version Latest

$script:AreaPolicies = [ordered]@{
    core        = "required"
    git         = "required"
    wit         = "required"
    build       = "required"
    work        = "required"
    release     = "conditional"
    wiki        = "supported"
    search      = "conditional"
    testplan    = "supported"
    test        = "supported"
    testresults = "conditional"
}

function Get-AzureDevOpsServerSupportMatrix {
    [CmdletBinding()]
    param()

    return $script:AreaPolicies.GetEnumerator() | ForEach-Object {
        [pscustomobject]@{
            Area    = $_.Key
            Support = $_.Value
        }
    }
}

function Normalize-AzureDevOpsServerCollectionUrl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$CollectionUrl
    )

    $candidate = $CollectionUrl.Trim()
    $uri = $null
    if (-not [System.Uri]::TryCreate($candidate, [System.UriKind]::Absolute, [ref]$uri)) {
        throw "Collection URL '$CollectionUrl' is not a valid absolute URI."
    }

    return $uri.AbsoluteUri.TrimEnd("/")
}

function Resolve-AzureDevOpsServerApiVersion {
    [CmdletBinding()]
    param(
        [string]$ApiVersion,
        [string]$ServerVersionHint
    )

    $resolved = if ($ApiVersion) {
        $ApiVersion.Trim()
    }
    else {
        switch ($ServerVersionHint) {
            { $_ -in @("current", "20.0", "2022.1") } { "7.1"; break }
            "2022" { "7.0"; break }
            "legacy" { "5.0"; break }
            default { "6.0" }
        }
    }

    if ($resolved -notmatch "^\d+\.\d+(-preview(\.\d+)?)?$") {
        throw "API version '$resolved' is invalid. Use values like 6.0, 7.0, or 7.1-preview.1."
    }

    return $resolved
}

function Resolve-AzureDevOpsServerVersionHint {
    [CmdletBinding()]
    param(
        [string]$ServerVersionHint
    )

    if ([string]::IsNullOrWhiteSpace($ServerVersionHint)) {
        return $null
    }

    switch ($ServerVersionHint.Trim()) {
        "current" { return "current" }
        "20.0" { return "20.0" }
        "2022.1" { return "2022.1" }
        "2022" { return "2022" }
        "2020" { return "2020" }
        "2019" { return "legacy" }
        "2018" { return "legacy" }
        "2017" { return "legacy" }
        "2015" { return "legacy" }
        "legacy" { return "legacy" }
        default {
            throw "Unsupported server version hint '$ServerVersionHint'. Use current, 20.0, 2022.1, 2022, 2020, 2019, 2018, 2017, 2015, or legacy."
        }
    }
}

function Get-AzureDevOpsServerConfiguration {
    [CmdletBinding()]
    param(
        [string]$CollectionUrl,
        [string]$Project,
        [string]$Team,
        [string]$AuthMode,
        [string]$Pat,
        [string]$ApiVersion,
        [string]$ServerVersionHint,
        [string]$SearchBaseUrl,
        [string]$TestResultsBaseUrl
    )

    $effectiveCollectionUrl = if ($CollectionUrl) {
        $CollectionUrl
    }
    elseif ($env:AZURE_DEVOPS_SERVER_COLLECTION_URL) {
        $env:AZURE_DEVOPS_SERVER_COLLECTION_URL
    }
    elseif ($env:SYSTEM_TEAMFOUNDATIONCOLLECTIONURI) {
        $env:SYSTEM_TEAMFOUNDATIONCOLLECTIONURI
    }
    else {
        throw "Set AZURE_DEVOPS_SERVER_COLLECTION_URL (or SYSTEM_TEAMFOUNDATIONCOLLECTIONURI) before using this skill."
    }

    $effectiveProject = if ($Project) {
        $Project
    }
    elseif ($env:AZURE_DEVOPS_SERVER_PROJECT) {
        $env:AZURE_DEVOPS_SERVER_PROJECT
    }
    elseif ($env:SYSTEM_TEAMPROJECT) {
        $env:SYSTEM_TEAMPROJECT
    }
    else {
        $null
    }

    $effectiveTeam = if ($Team) {
        $Team
    }
    elseif ($env:AZURE_DEVOPS_SERVER_TEAM) {
        $env:AZURE_DEVOPS_SERVER_TEAM
    }
    else {
        $null
    }

    $effectiveAuthMode = if ($AuthMode) {
        $AuthMode
    }
    elseif ($env:AZURE_DEVOPS_SERVER_AUTH_MODE) {
        $env:AZURE_DEVOPS_SERVER_AUTH_MODE
    }
    else {
        "default-credentials"
    }

    if ([string]::IsNullOrWhiteSpace($effectiveAuthMode)) {
        $effectiveAuthMode = "default-credentials"
    }

    if ($effectiveAuthMode -notin @("pat", "default-credentials")) {
        throw "Unsupported auth mode '$effectiveAuthMode'. Use 'pat' or 'default-credentials'."
    }

    $effectivePat = if ($Pat) {
        $Pat
    }
    elseif ($env:AZURE_DEVOPS_SERVER_PAT) {
        $env:AZURE_DEVOPS_SERVER_PAT
    }
    else {
        $null
    }

    $rawServerVersionHint = if ($ServerVersionHint) {
        $ServerVersionHint
    }
    elseif ($env:AZURE_DEVOPS_SERVER_SERVER_VERSION) {
        $env:AZURE_DEVOPS_SERVER_SERVER_VERSION
    }
    else {
        $null
    }
    $effectiveServerVersionHint = Resolve-AzureDevOpsServerVersionHint -ServerVersionHint $rawServerVersionHint

    if ($effectiveAuthMode -eq "pat" -and [string]::IsNullOrWhiteSpace($effectivePat)) {
        throw "Auth mode 'pat' requires AZURE_DEVOPS_SERVER_PAT or the -Pat parameter."
    }

    $rawApiVersion = if (-not [string]::IsNullOrWhiteSpace($ApiVersion)) {
        $ApiVersion
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:AZURE_DEVOPS_SERVER_API_VERSION)) {
        $env:AZURE_DEVOPS_SERVER_API_VERSION
    }
    else {
        $null
    }

    $normalizedCollectionUrl = Normalize-AzureDevOpsServerCollectionUrl -CollectionUrl $effectiveCollectionUrl
    $resolvedApiVersion = Resolve-AzureDevOpsServerApiVersion -ApiVersion $rawApiVersion -ServerVersionHint $effectiveServerVersionHint
    $effectiveSearchBaseUrl = if ($SearchBaseUrl) {
        Normalize-AzureDevOpsServerCollectionUrl -CollectionUrl $SearchBaseUrl
    }
    elseif ($env:AZURE_DEVOPS_SERVER_SEARCH_BASE_URL) {
        Normalize-AzureDevOpsServerCollectionUrl -CollectionUrl $env:AZURE_DEVOPS_SERVER_SEARCH_BASE_URL
    }
    else {
        $null
    }
    $effectiveTestResultsBaseUrl = if ($TestResultsBaseUrl) {
        Normalize-AzureDevOpsServerCollectionUrl -CollectionUrl $TestResultsBaseUrl
    }
    elseif ($env:AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL) {
        Normalize-AzureDevOpsServerCollectionUrl -CollectionUrl $env:AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL
    }
    else {
        $null
    }

    return [pscustomobject]@{
        CollectionUrl       = $normalizedCollectionUrl
        Project             = $effectiveProject
        Team                = $effectiveTeam
        AuthMode            = $effectiveAuthMode
        Pat                 = $effectivePat
        ApiVersion          = $resolvedApiVersion
        ServerVersionHint   = $effectiveServerVersionHint
        SearchBaseUrl       = $effectiveSearchBaseUrl
        TestResultsBaseUrl  = $effectiveTestResultsBaseUrl
    }
}

function Get-AzureDevOpsServerAreaBaseUrl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Configuration,
        [Parameter(Mandatory)]
        [pscustomobject]$Policy
    )

    switch ($Policy.Area) {
        "search" {
            if ($Configuration.SearchBaseUrl) {
                return $Configuration.SearchBaseUrl
            }
        }
        "testresults" {
            if ($Configuration.TestResultsBaseUrl) {
                return $Configuration.TestResultsBaseUrl
            }
        }
    }

    return $Configuration.CollectionUrl
}

function Get-AzureDevOpsServerAreaPolicy {
    [CmdletBinding()]
    param(
        [string]$Area
    )

    $normalizedArea = if ([string]::IsNullOrWhiteSpace($Area)) {
        "core"
    }
    else {
        $Area.Trim().ToLowerInvariant()
    }

    $support = if ($script:AreaPolicies.Contains($normalizedArea)) {
        $script:AreaPolicies[$normalizedArea]
    }
    else {
        "custom"
    }

    return [pscustomobject]@{
        Area    = $normalizedArea
        Support = $support
    }
}

function Assert-AzureDevOpsServerAreaSupported {
    [CmdletBinding()]
    param(
        [string]$Area,
        [switch]$AllowConditionalArea
    )

    $policy = Get-AzureDevOpsServerAreaPolicy -Area $Area

    switch ($policy.Support) {
        "conditional" {
            if (-not $AllowConditionalArea) {
                $message = switch ($policy.Area) {
                    "release" {
                        "Area 'release' is conditional. Run Test-AzureDevOpsServerConnection.ps1 -CheckReleaseArea first, then retry with -AllowConditionalArea only after the probe succeeds."
                    }
                    "search" {
                        "Area 'search' is conditional. Run Test-AzureDevOpsServerConnection.ps1 -CheckSearchArea first, optionally set AZURE_DEVOPS_SERVER_SEARCH_BASE_URL when this deployment uses a dedicated search host, then retry with -AllowConditionalArea only after the probe succeeds."
                    }
                    "testresults" {
                        "Area 'testresults' is conditional. Run Test-AzureDevOpsServerConnection.ps1 -CheckTestResultsArea first, optionally set AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL when this deployment uses a dedicated test results host, then retry with -AllowConditionalArea only after the probe succeeds."
                    }
                    default {
                        "Area '$($policy.Area)' is conditional. Probe the target server first, then retry with -AllowConditionalArea only after the probe succeeds."
                    }
                }

                throw $message
            }
        }
    }

    return $policy
}

function Test-AzureDevOpsServerCollectionScopedResource {
    [CmdletBinding()]
    param(
        [string]$Area,
        [string]$Resource
    )

    if ([string]::IsNullOrWhiteSpace($Resource)) {
        return $false
    }

    $normalizedArea = if ([string]::IsNullOrWhiteSpace($Area)) {
        ""
    }
    else {
        $Area.Trim().ToLowerInvariant()
    }
    $normalizedResource = $Resource.Trim("/").ToLowerInvariant()

    if ([string]::IsNullOrWhiteSpace($normalizedArea)) {
        return ($normalizedResource -match "^(projects|teams)(/|$)")
    }

    if ($normalizedArea -eq "wiki" -and $normalizedResource -eq "wikis") {
        return $true
    }

    if ($normalizedArea -eq "git" -and $normalizedResource -match "^pullrequests/\d+$") {
        return $true
    }

    return $false
}

function Test-AzureDevOpsServerSafeReadRoute {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Method,
        [string]$Area,
        [string]$Resource
    )

    if ($Method -eq "GET") {
        return $true
    }

    if ($Method -ne "POST") {
        return $false
    }

    $normalizedArea = if ([string]::IsNullOrWhiteSpace($Area)) {
        ""
    }
    else {
        $Area.Trim().ToLowerInvariant()
    }

    $normalizedResource = if ([string]::IsNullOrWhiteSpace($Resource)) {
        ""
    }
    else {
        $Resource.Trim("/").ToLowerInvariant()
    }

    switch ($normalizedArea) {
        "wit" {
            return ($normalizedResource -eq "wiql")
        }
        "wiki" {
            return ($normalizedResource -match "^wikis/[^/]+/pagesbatch$")
        }
        "search" {
            return ($normalizedResource -in @(
                    "workitemsearchresults",
                    "codesearchresults",
                    "wikisearchresults"
                ))
        }
        default {
            return $false
        }
    }
}

function ConvertTo-AzureDevOpsServerQueryString {
    [CmdletBinding()]
    param(
        [hashtable]$Query
    )

    if (-not $Query -or $Query.Count -eq 0) {
        return ""
    }

    $pairs = New-Object System.Collections.Generic.List[string]
    foreach ($key in ($Query.Keys | Sort-Object)) {
        $value = $Query[$key]
        if ($null -eq $value) {
            continue
        }

        if ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) {
            foreach ($item in $value) {
                $pairs.Add(("{0}={1}" -f [System.Uri]::EscapeDataString([string]$key), [System.Uri]::EscapeDataString([string]$item)))
            }
        }
        else {
            $pairs.Add(("{0}={1}" -f [System.Uri]::EscapeDataString([string]$key), [System.Uri]::EscapeDataString([string]$value)))
        }
    }

    return ($pairs -join "&")
}

function New-AzureDevOpsServerApiUri {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$CollectionUrl,
        [string]$Project,
        [string]$Team,
        [string]$Area,
        [string]$Resource,
        [Parameter(Mandatory)]
        [string]$ApiVersion,
        [hashtable]$Query
    )

    $path = $CollectionUrl.TrimEnd("/")

    if (-not [string]::IsNullOrWhiteSpace($Project)) {
        $path = "{0}/{1}" -f $path, [System.Uri]::EscapeDataString($Project.Trim("/"))
    }

    if (-not [string]::IsNullOrWhiteSpace($Team)) {
        if ([string]::IsNullOrWhiteSpace($Project)) {
            throw "A team-scoped request requires a project. Set -Project before using -Team."
        }

        $path = "{0}/{1}" -f $path, [System.Uri]::EscapeDataString($Team.Trim("/"))
    }

    $path = "{0}/_apis" -f $path

    if (-not [string]::IsNullOrWhiteSpace($Area)) {
        $path = "{0}/{1}" -f $path, $Area.Trim("/")
    }

    if (-not [string]::IsNullOrWhiteSpace($Resource)) {
        $path = "{0}/{1}" -f $path, $Resource.Trim("/")
    }

    $effectiveQuery = @{}
    if ($Query) {
        foreach ($entry in $Query.GetEnumerator()) {
            $effectiveQuery[$entry.Key] = $entry.Value
        }
    }
    $effectiveQuery["api-version"] = $ApiVersion

    $queryString = ConvertTo-AzureDevOpsServerQueryString -Query $effectiveQuery
    if ([string]::IsNullOrWhiteSpace($queryString)) {
        return $path
    }

    return "{0}?{1}" -f $path, $queryString
}

function New-AzureDevOpsServerHeaders {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Pat
    )

    $tokenBytes = [System.Text.Encoding]::ASCII.GetBytes((":{0}" -f $Pat))
    return @{
        Authorization = "Basic {0}" -f [Convert]::ToBase64String($tokenBytes)
        Accept        = "application/json"
    }
}

function ConvertTo-AzureDevOpsServerBody {
    [CmdletBinding()]
    param(
        [object]$Body
    )

    if ($null -eq $Body) {
        return $null
    }

    if ($Body -is [string]) {
        return $Body
    }

    if ($Body -is [System.Collections.IEnumerable] -and -not ($Body -is [string]) -and -not ($Body -is [hashtable])) {
        $items = New-Object System.Collections.Generic.List[string]
        foreach ($item in $Body) {
            $items.Add(($item | ConvertTo-Json -Depth 100 -Compress))
        }

        return "[{0}]" -f ($items -join ",")
    }

    return ($Body | ConvertTo-Json -Depth 100 -Compress)
}

function Read-AzureDevOpsServerErrorBody {
    [CmdletBinding()]
    param(
        [object]$Response
    )

    if ($null -eq $Response) {
        return $null
    }

    try {
        if ($Response -is [System.Net.Http.HttpResponseMessage]) {
            if ($Response.Content) {
                return $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            }
        }
        elseif ($Response.GetType().GetProperty("Content")) {
            $content = $Response.Content
            if ($content) {
                return $content.ReadAsStringAsync().GetAwaiter().GetResult()
            }
        }
        elseif ($Response.GetType().GetProperty("GetResponseStream")) {
            $stream = $Response.GetResponseStream()
            if ($stream) {
                $reader = [System.IO.StreamReader]::new($stream)
                return $reader.ReadToEnd()
            }
        }
    }
    catch {
        return $null
    }

    return $null
}

function Resolve-AzureDevOpsServerErrorMessage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [System.Management.Automation.ErrorRecord]$ErrorRecord,
        [Parameter(Mandatory)]
        [string]$Uri,
        [Parameter(Mandatory)]
        [pscustomobject]$Configuration,
        [Parameter(Mandatory)]
        [pscustomobject]$Policy
    )

    $response = $null
    $statusCode = $null
    $reasonPhrase = $null
    if ($ErrorRecord.Exception.PSObject.Properties["Response"]) {
        $response = $ErrorRecord.Exception.Response
    }
    $responseBody = Read-AzureDevOpsServerErrorBody -Response $response

    if ($response) {
        if ($response -is [System.Net.Http.HttpResponseMessage]) {
            $statusCode = [int]$response.StatusCode
            $reasonPhrase = $response.ReasonPhrase
        }
        elseif ($response.GetType().GetProperty("StatusCode")) {
            $statusCode = [int]$response.StatusCode
            $reasonPhrase = [string]$response.StatusCode
        }
    }

    $hint = switch ($statusCode) {
        400 { "The route, query, body, or api-version is invalid for this server. Check the selected ServerVersionHint against the target server release." }
        401 { "Authentication failed. Verify AZURE_DEVOPS_SERVER_AUTH_MODE and the PAT or Windows identity." }
        403 { "Authentication succeeded but the identity does not have permission for this route or area." }
        404 {
            if ($Policy.Area -eq "release") {
                "The release area is unavailable on this server or collection. Keep release support disabled for this target."
            }
            else {
                "The route does not exist on this server or api-version. Check the area, resource path, and support matrix."
            }
        }
        default { "Inspect the request URL, auth mode, area support, and api-version before retrying." }
    }

    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add("Request failed for $Uri.")
    if ($null -ne $statusCode) {
        if ($reasonPhrase) {
            $parts.Add("HTTP $statusCode ($reasonPhrase).")
        }
        else {
            $parts.Add("HTTP $statusCode.")
        }
    }
    $parts.Add($hint)
    if ($Configuration.ServerVersionHint -eq "legacy") {
        $parts.Add("The target is explicitly marked as legacy; behavior outside the current, 2022/2022.1, and 2020 first-class targets is best-effort only.")
    }
    if (-not [string]::IsNullOrWhiteSpace($responseBody)) {
        $parts.Add("Response: $responseBody")
    }

    return ($parts -join " ")
}

function Invoke-AzureDevOpsServerRequest {
    [CmdletBinding()]
    param(
        [ValidateSet("GET", "POST", "PUT", "PATCH", "DELETE")]
        [string]$Method = "GET",
        [string]$Area,
        [string]$Resource,
        [string]$Project,
        [string]$Team,
        [hashtable]$Query,
        [object]$Body,
        [string]$CollectionUrl,
        [string]$AuthMode,
        [string]$Pat,
        [string]$ApiVersion,
        [string]$ServerVersionHint,
        [string]$SearchBaseUrl,
        [string]$TestResultsBaseUrl,
        [switch]$AllowConditionalArea,
        [switch]$DryRun,
        [switch]$JsonPatch,
        [switch]$AllowWrite
    )

    $configuration = Get-AzureDevOpsServerConfiguration `
        -CollectionUrl $CollectionUrl `
        -Project $Project `
        -Team $Team `
        -AuthMode $AuthMode `
        -Pat $Pat `
        -ApiVersion $ApiVersion `
        -ServerVersionHint $ServerVersionHint `
        -SearchBaseUrl $SearchBaseUrl `
        -TestResultsBaseUrl $TestResultsBaseUrl

    $policy = Assert-AzureDevOpsServerAreaSupported -Area $Area -AllowConditionalArea:$AllowConditionalArea
    $effectiveProject = $configuration.Project
    $effectiveTeam = $null
    $baseUrl = Get-AzureDevOpsServerAreaBaseUrl -Configuration $configuration -Policy $policy

    if (Test-AzureDevOpsServerCollectionScopedResource -Area $Area -Resource $Resource) {
        $effectiveProject = $null
    }
    elseif (-not [string]::IsNullOrWhiteSpace($Team)) {
        $effectiveTeam = $configuration.Team
    }
    elseif ($policy.Area -eq "work") {
        $effectiveTeam = $configuration.Team
    }

    $requestUri = New-AzureDevOpsServerApiUri `
        -CollectionUrl $baseUrl `
        -Project $effectiveProject `
        -Team $effectiveTeam `
        -Area $Area `
        -Resource $Resource `
        -ApiVersion $configuration.ApiVersion `
        -Query $Query

    $isWrite = $Method -in @("POST", "PUT", "PATCH", "DELETE")
    if ($isWrite -and (Test-AzureDevOpsServerSafeReadRoute -Method $Method -Area $policy.Area -Resource $Resource)) {
        $isWrite = $false
    }

    if ($isWrite -and -not $DryRun -and -not $AllowWrite) {
        throw "Live writes are blocked by default. Re-run with -DryRun first, review the payload, then add -AllowWrite for the live request."
    }

    $bodyText = ConvertTo-AzureDevOpsServerBody -Body $Body
    $preview = [pscustomobject]@{
        Method            = $Method
        Uri               = $requestUri
        BaseUrl           = $baseUrl
        Area              = $policy.Area
        AreaSupport       = $policy.Support
        AuthMode          = $configuration.AuthMode
        ApiVersion        = $configuration.ApiVersion
        Project           = $effectiveProject
        Team              = $effectiveTeam
        HasBody           = ($null -ne $bodyText)
        Body              = $bodyText
        DryRun            = [bool]$DryRun
        RequiresAllowWrite = [bool]$isWrite
        ServerVersionHint = $configuration.ServerVersionHint
    }

    if ($DryRun) {
        return $preview
    }

    $invokeParams = @{
        Method      = $Method
        Uri         = $requestUri
        ErrorAction = "Stop"
    }

    if ($configuration.AuthMode -eq "pat") {
        $invokeParams.Headers = New-AzureDevOpsServerHeaders -Pat $configuration.Pat
    }
    else {
        $invokeParams.UseDefaultCredentials = $true
        if ($requestUri.StartsWith("http://", [System.StringComparison]::OrdinalIgnoreCase)) {
            $invokeParams.AllowUnencryptedAuthentication = $true
        }
    }

    if ($null -ne $bodyText) {
        $invokeParams.Body = $bodyText
        $invokeParams.ContentType = if ($JsonPatch) {
            "application/json-patch+json"
        }
        else {
            "application/json"
        }
    }

    try {
        return Invoke-RestMethod @invokeParams
    }
    catch {
        $message = Resolve-AzureDevOpsServerErrorMessage `
            -ErrorRecord $_ `
            -Uri $requestUri `
            -Configuration $configuration `
            -Policy $policy
        throw [System.InvalidOperationException]::new($message, $_.Exception)
    }
}

function Test-AzureDevOpsServerBootstrap {
    [CmdletBinding()]
    param(
        [string]$CollectionUrl,
        [string]$Project,
        [string]$Team,
        [string]$AuthMode,
        [string]$Pat,
        [string]$ApiVersion,
        [string]$ServerVersionHint,
        [string]$SearchBaseUrl,
        [string]$TestResultsBaseUrl,
        [switch]$CheckReleaseArea,
        [switch]$CheckSearchArea,
        [switch]$CheckTestResultsArea,
        [switch]$DryRun
    )

    $configuration = Get-AzureDevOpsServerConfiguration `
        -CollectionUrl $CollectionUrl `
        -Project $Project `
        -Team $Team `
        -AuthMode $AuthMode `
        -Pat $Pat `
        -ApiVersion $ApiVersion `
        -ServerVersionHint $ServerVersionHint `
        -SearchBaseUrl $SearchBaseUrl `
        -TestResultsBaseUrl $TestResultsBaseUrl

    $projectsUri = New-AzureDevOpsServerApiUri `
        -CollectionUrl $configuration.CollectionUrl `
        -Project $null `
        -Area "" `
        -Resource "projects" `
        -ApiVersion $configuration.ApiVersion `
        -Query @{ '$top' = 1 }

    $probeProjectFallback = "<project-required-for-conditional-probes>"
    $releaseProbeProject = if ($configuration.Project) { $configuration.Project } else { $probeProjectFallback }
    $releaseUri = New-AzureDevOpsServerApiUri `
        -CollectionUrl $configuration.CollectionUrl `
        -Project $releaseProbeProject `
        -Area "release" `
        -Resource "definitions" `
        -ApiVersion $configuration.ApiVersion `
        -Query @{ '$top' = 1 }
    $searchProbeProject = if ($configuration.Project) { $configuration.Project } else { $probeProjectFallback }
    $searchProbeBaseUrl = if ($configuration.SearchBaseUrl) { $configuration.SearchBaseUrl } else { $configuration.CollectionUrl }
    $searchProbeUri = New-AzureDevOpsServerApiUri `
        -CollectionUrl $searchProbeBaseUrl `
        -Project $searchProbeProject `
        -Area "search" `
        -Resource "workitemsearchresults" `
        -ApiVersion $configuration.ApiVersion `
        -Query @{}
    $testResultsProbeProject = if ($configuration.Project) { $configuration.Project } else { $probeProjectFallback }
    $testResultsProbeBaseUrl = if ($configuration.TestResultsBaseUrl) { $configuration.TestResultsBaseUrl } else { $configuration.CollectionUrl }
    $testResultsProbeApiVersion = "6.0-preview.1"
    $testResultsProbeBuildId = 1
    $testResultsProbeUri = New-AzureDevOpsServerApiUri `
        -CollectionUrl $testResultsProbeBaseUrl `
        -Project $testResultsProbeProject `
        -Area "testresults" `
        -Resource "resultsummarybybuild" `
        -ApiVersion $testResultsProbeApiVersion `
        -Query @{ buildId = $testResultsProbeBuildId }

    if ($DryRun) {
        return [pscustomobject]@{
            CollectionUrl          = $configuration.CollectionUrl
            Project                = $configuration.Project
            Team                   = $configuration.Team
            ApiVersion             = $configuration.ApiVersion
            AuthMode               = $configuration.AuthMode
            ServerVersionHint      = $configuration.ServerVersionHint
            RequiredReadBootstrap  = "dry-run"
            ProjectsProbeUri       = $projectsUri
            ReleaseAreaStatus      = if ($CheckReleaseArea) { "dry-run" } else { "not-requested" }
            ReleaseProbeUri        = if ($CheckReleaseArea) { $releaseUri } else { $null }
            ReleaseAreaMessage     = if ($CheckReleaseArea) { "Dry-run only. No live request was sent." } else { "Release probe not requested." }
            SearchAreaStatus       = if ($CheckSearchArea) { "dry-run" } else { "not-requested" }
            SearchProbeUri         = if ($CheckSearchArea) { $searchProbeUri } else { $null }
            SearchAreaMessage      = if ($CheckSearchArea) { "Dry-run only. No live request was sent. Set AZURE_DEVOPS_SERVER_SEARCH_BASE_URL if this deployment uses a dedicated search host." } else { "Search probe not requested." }
            TestResultsAreaStatus  = if ($CheckTestResultsArea) { "dry-run" } else { "not-requested" }
            TestResultsProbeUri    = if ($CheckTestResultsArea) { $testResultsProbeUri } else { $null }
            TestResultsAreaMessage = if ($CheckTestResultsArea) { "Dry-run only. No live request was sent. Set AZURE_DEVOPS_SERVER_TESTRESULTS_BASE_URL if this deployment uses a dedicated test results host." } else { "Test results probe not requested." }
            SampleProjectForProbes = if ($configuration.Project) { $configuration.Project } else { $probeProjectFallback }
        }
    }

    $projectsResponse = Invoke-AzureDevOpsServerRequest `
        -Method "GET" `
        -Area "" `
        -Resource "projects" `
        -Project $null `
        -Query @{ '$top' = 1 } `
        -CollectionUrl $configuration.CollectionUrl `
        -AuthMode $configuration.AuthMode `
        -Pat $configuration.Pat `
        -ApiVersion $configuration.ApiVersion `
        -ServerVersionHint $configuration.ServerVersionHint

    $sampleProject = if ($configuration.Project) {
        $configuration.Project
    }
    elseif ($projectsResponse.value -and $projectsResponse.value.Count -gt 0) {
        $projectsResponse.value[0].name
    }
    else {
        $null
    }

    $releaseStatus = "not-checked"
    $releaseMessage = "Release probe not requested."
    $searchStatus = "not-checked"
    $searchMessage = "Search probe not requested."
    $testResultsStatus = "not-checked"
    $testResultsMessage = "Test results probe not requested."

    if ($CheckReleaseArea) {
        if ([string]::IsNullOrWhiteSpace($sampleProject)) {
            $releaseStatus = "project-required"
            $releaseMessage = "Release probe skipped because no project was configured and no sample project was available."
        }
        else {
            try {
                $null = Invoke-AzureDevOpsServerRequest `
                    -Method "GET" `
                    -Area "release" `
                    -Resource "definitions" `
                    -Project $sampleProject `
                    -Query @{ '$top' = 1 } `
                    -CollectionUrl $configuration.CollectionUrl `
                    -AuthMode $configuration.AuthMode `
                    -Pat $configuration.Pat `
                    -ApiVersion $configuration.ApiVersion `
                    -ServerVersionHint $configuration.ServerVersionHint `
                    -AllowConditionalArea

                $releaseStatus = "available"
                $releaseMessage = "Release definitions endpoint responded successfully."
            }
            catch {
                $releaseStatus = "unavailable"
                $releaseMessage = $_.Exception.Message
            }
        }
    }

    if ($CheckSearchArea) {
        if ([string]::IsNullOrWhiteSpace($sampleProject)) {
            $searchStatus = "project-required"
            $searchMessage = "Search probe skipped because no project was configured and no sample project was available."
        }
        else {
            try {
                $null = Invoke-AzureDevOpsServerRequest `
                    -Method "POST" `
                    -Area "search" `
                    -Resource "workitemsearchresults" `
                    -Project $sampleProject `
                    -Body @{ searchText = "a"; '$top' = 1 } `
                    -CollectionUrl $configuration.CollectionUrl `
                    -SearchBaseUrl $configuration.SearchBaseUrl `
                    -AuthMode $configuration.AuthMode `
                    -Pat $configuration.Pat `
                    -ApiVersion $configuration.ApiVersion `
                    -ServerVersionHint $configuration.ServerVersionHint `
                    -AllowConditionalArea

                $searchStatus = "available"
                $searchMessage = "Search endpoint responded successfully."
            }
            catch {
                $searchStatus = "probe-failed"
                $searchMessage = "Representative search probe failed. The deployment may still require a different base URL, api-version, or search/index configuration. $($_.Exception.Message)"
            }
        }
    }

    if ($CheckTestResultsArea) {
        if ([string]::IsNullOrWhiteSpace($sampleProject)) {
            $testResultsStatus = "project-required"
            $testResultsMessage = "Test results probe skipped because no project was configured and no sample project was available."
        }
        else {
            try {
                $null = Invoke-AzureDevOpsServerRequest `
                    -Method "GET" `
                    -Area "testresults" `
                    -Resource "resultsummarybybuild" `
                    -Project $sampleProject `
                    -Query @{ buildId = $testResultsProbeBuildId } `
                    -CollectionUrl $configuration.CollectionUrl `
                    -TestResultsBaseUrl $configuration.TestResultsBaseUrl `
                    -AuthMode $configuration.AuthMode `
                    -Pat $configuration.Pat `
                    -ApiVersion $testResultsProbeApiVersion `
                    -ServerVersionHint $configuration.ServerVersionHint `
                    -AllowConditionalArea

                $testResultsStatus = "available"
                $testResultsMessage = "Test results build summary endpoint responded successfully for build ID $testResultsProbeBuildId."
            }
            catch {
                $testResultsStatus = "probe-failed"
                $testResultsMessage = "Representative test results probe failed. The deployment may still require a different base URL or api-version for the tested route. $($_.Exception.Message)"
            }
        }
    }

    return [pscustomobject]@{
        CollectionUrl          = $configuration.CollectionUrl
        Project                = $configuration.Project
        Team                   = $configuration.Team
        ApiVersion             = $configuration.ApiVersion
        AuthMode               = $configuration.AuthMode
        ServerVersionHint      = $configuration.ServerVersionHint
        ProjectsProbeUri       = $projectsUri
        ProjectSampleCount     = if ($projectsResponse.count) { $projectsResponse.count } elseif ($projectsResponse.value) { $projectsResponse.value.Count } else { 0 }
        SampleProjectForProbes = $sampleProject
        RequiredReadBootstrap  = "ok"
        ReleaseAreaStatus      = $releaseStatus
        ReleaseAreaMessage     = $releaseMessage
        SearchProbeUri         = if ($CheckSearchArea) { $searchProbeUri } else { $null }
        SearchAreaStatus       = $searchStatus
        SearchAreaMessage      = $searchMessage
        TestResultsProbeUri    = if ($CheckTestResultsArea) { $testResultsProbeUri } else { $null }
        TestResultsAreaStatus  = $testResultsStatus
        TestResultsAreaMessage = $testResultsMessage
    }
}

Export-ModuleMember -Function `
    Get-AzureDevOpsServerConfiguration, `
    Get-AzureDevOpsServerSupportMatrix, `
    Invoke-AzureDevOpsServerRequest, `
    New-AzureDevOpsServerApiUri, `
    Normalize-AzureDevOpsServerCollectionUrl, `
    Resolve-AzureDevOpsServerApiVersion, `
    Test-AzureDevOpsServerBootstrap
