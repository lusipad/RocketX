param(
  [string]$ProcessName = 'rocketx',
  [ValidateRange(1, 10000)]
  [int]$Samples = 1,
  [ValidateRange(0, 86400)]
  [int]$IntervalSeconds = 60,
  [double]$MaxPrivateMB = 0,
  [double]$MaxGrowthMB = 0,
  [string]$CsvPath = ''
)

function Get-MemorySnapshot {
  $all = Get-CimInstance Win32_Process
  $roots = @($all | Where-Object { $_.Name -ieq "$ProcessName.exe" })
  if ($roots.Count -eq 0) {
    throw "$ProcessName.exe not found; start the desktop client first"
  }

  $ids = [System.Collections.Generic.HashSet[uint32]]::new()
  $queue = [System.Collections.Generic.Queue[uint32]]::new()
  foreach ($root in $roots) {
    [void]$ids.Add([uint32]$root.ProcessId)
    $queue.Enqueue([uint32]$root.ProcessId)
  }
  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parent }) {
      if ($ids.Add([uint32]$child.ProcessId)) {
        $queue.Enqueue([uint32]$child.ProcessId)
      }
    }
  }

  $measured = @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) })
  $workingSet = ($measured | Measure-Object -Property WorkingSetSize -Sum).Sum
  $private = ($measured | Measure-Object -Property PrivatePageCount -Sum).Sum
  [pscustomobject]@{
    Timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    ProcessCount = $measured.Count
    WorkingSetMB = [math]::Round([double]$workingSet / 1MB, 1)
    PrivateMB = [math]::Round([double]$private / 1MB, 1)
    Processes = $measured
  }
}

$snapshots = @()
for ($i = 0; $i -lt $Samples; $i++) {
  $snapshot = Get-MemorySnapshot
  $snapshots += $snapshot
  "[$($i + 1)/$Samples] $($snapshot.Timestamp) Processes=$($snapshot.ProcessCount) WorkingSet=$($snapshot.WorkingSetMB) MB Private=$($snapshot.PrivateMB) MB"
  if ($i -lt $Samples - 1 -and $IntervalSeconds -gt 0) {
    Start-Sleep -Seconds $IntervalSeconds
  }
}

$last = $snapshots[-1]
$last.Processes | Sort-Object Name, ProcessId | Select-Object Name, ProcessId, @{
  Name = 'WorkingSetMB'
  Expression = { [math]::Round([double]$_.WorkingSetSize / 1MB, 1) }
}, @{
  Name = 'PrivateMB'
  Expression = { [math]::Round([double]$_.PrivatePageCount / 1MB, 1) }
} | Format-Table -AutoSize

$firstPrivate = [double]$snapshots[0].PrivateMB
$peakPrivate = [double](($snapshots | Measure-Object -Property PrivateMB -Maximum).Maximum)
$growth = [math]::Round([double]$last.PrivateMB - $firstPrivate, 1)
"ProcessCount: $($last.ProcessCount)"
"TotalWorkingSetMB: $($last.WorkingSetMB)"
"TotalPrivateMB: $($last.PrivateMB)"
"PeakPrivateMB: $peakPrivate"
"PrivateGrowthMB: $growth"

if ($CsvPath) {
  $snapshots | Select-Object Timestamp, ProcessCount, WorkingSetMB, PrivateMB |
    Export-Csv -NoTypeInformation -Encoding UTF8 -Path $CsvPath
  "CsvPath: $CsvPath"
}

$failures = @()
if ($MaxPrivateMB -gt 0 -and $peakPrivate -gt $MaxPrivateMB) {
  $failures += "Peak private memory $peakPrivate MB exceeds $MaxPrivateMB MB"
}
if ($MaxGrowthMB -gt 0 -and $growth -gt $MaxGrowthMB) {
  $failures += "Private memory growth $growth MB exceeds $MaxGrowthMB MB"
}
if ($failures.Count -gt 0) {
  throw ($failures -join '; ')
}
