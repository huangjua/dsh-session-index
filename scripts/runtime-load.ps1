param([Parameter(Mandatory=$true)][string]$Output, [Parameter(Mandatory=$true)][string]$StopFile)
$ErrorActionPreference='Stop'
while (-not (Test-Path -LiteralPath $StopFile)) {
  try {
    $processors=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    $disks=Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Select-Object Name,DiskReadBytesPerSec,DiskWriteBytesPerSec,PercentDiskTime,AvgDisksecPerRead,AvgDisksecPerWrite,CurrentDiskQueueLength
    $sample=[ordered]@{ at=(Get-Date).ToUniversalTime().ToString('o'); cpuPercent=$processors.PercentProcessorTime; disks=@($disks); scope='Windows global counters; includes unrelated host activity'; intervalMs=3000 }
  } catch { $sample=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o'); unavailable=$true} }
  Add-Content -LiteralPath $Output -Value ($sample | ConvertTo-Json -Depth 5 -Compress) -Encoding utf8
  Start-Sleep -Milliseconds 3000
}
