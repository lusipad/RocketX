# API Version Matrix

## Use This File For

- choosing a safe default `api-version`
- deciding when to override for current Azure DevOps Server or Azure DevOps Server 2022
- understanding support limits for older TFS

## Microsoft Support Matrix

Microsoft's REST API versioning guidance lists:

- Azure DevOps Server vNext: REST API `7.2`
- Azure DevOps Server 2022.1: supports `1.0` through `7.1`
- Azure DevOps Server 2022: supports `1.0` through `7.0`
- Azure DevOps Server 2020: supports `1.0` through `6.0`
- Azure DevOps Server 2019: supports `1.0` through `5.0`
- TFS 2018: supports `1.0` through `4.0`

## Skill Default

This skill defaults to:

- `7.1` when the server hint is `current`, `20.0`, or `2022.1`
- `7.0` when the server hint is `2022`
- `6.0` when the server hint is `2020` or unspecified
- `5.0` when the server hint maps to `legacy`

Rationale:

- it keeps Azure DevOps Server 2020 safe by default
- it uses `7.1` for current/20.0 and 2022.1 targets; the local 20.0.37104.1 validation target accepted `7.1` across core resource areas but rejected stable `7.2`
- it uses `7.0` when the target is explicitly marked as 2022
- it avoids choosing a too-new version for older TFS hints

If you know the target is Azure DevOps Server 2022 and an endpoint requires newer behavior, set:

```powershell
$env:AZURE_DEVOPS_SERVER_API_VERSION = "7.0"
```

Or pass:

```powershell
-ApiVersion 7.0
```

## Server Version Hint

Optional:

```powershell
$env:AZURE_DEVOPS_SERVER_SERVER_VERSION = "2022"
```

Accepted values:

- `current`
- `20.0`
- `2022.1`
- `2022`
- `2020`
- `2019`
- `2018`
- `2017`
- `2015`
- `legacy`

The helper maps `2019`, `2018`, `2017`, and `2015` to `legacy` for best-effort behavior. It does not claim to auto-detect every server build.

## Upgrade Rules

- keep `6.0` as the safe default when the server version is unknown
- use `7.1` for a confirmed current/20.0 or 2022.1 target
- do not assume stable `7.2` support from the product major version alone; probe the deployment before overriding to `7.2`
- use `5.0` for explicit legacy hints unless the target proves it needs something else
- prefer explicit overrides over silent guessing
- if older TFS behavior appears, report that the target is outside first-class support

## Extended-Area Notes

The `wiki`, `search`, `testplan`, `test`, and `testresults` routes in this repository still follow the same defaulting rules:

- start with the skill default for the target server hint
- only raise `api-version` when the target server is known to support it
- treat preview-only Microsoft Learn examples as hints, not as a reason to silently force preview versions

Practical rule:

- Azure DevOps Server 2020: stay on `6.0` unless the server proves otherwise
- Azure DevOps Server 2022: prefer `7.0` when the route needs a newer shape
- Azure DevOps Server 2022.1 or current 20.0: prefer `7.1`; raise to `7.2` only after a successful target-server probe
- preview versions: use only with an explicit operator override and a known-good target
