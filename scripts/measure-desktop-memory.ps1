param(
  [string]$ProcessName = 'rocketx'
)

$all = Get-CimInstance Win32_Process
$roots = @($all | Where-Object { $_.Name -ieq "$ProcessName.exe" })
if ($roots.Count -eq 0) {
  throw "未找到 $ProcessName.exe，请先启动桌面客户端"
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
$rows = $measured | Sort-Object Name, ProcessId | Select-Object Name, ProcessId, @{
  Name = 'WorkingSetMB'
  Expression = { [math]::Round([double]$_.WorkingSetSize / 1MB, 1) }
}, @{
  Name = 'PrivateMB'
  Expression = { [math]::Round([double]$_.PrivatePageCount / 1MB, 1) }
}
$rows | Format-Table -AutoSize

$total = ($measured | Measure-Object -Property WorkingSetSize -Sum).Sum
$private = ($measured | Measure-Object -Property PrivatePageCount -Sum).Sum
"ProcessCount: $($measured.Count)"
"TotalWorkingSetMB: $([math]::Round([double]$total / 1MB, 1))"
"TotalPrivateMB: $([math]::Round([double]$private / 1MB, 1))"
