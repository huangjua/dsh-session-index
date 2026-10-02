# Restore the approved installed Desktop after the temporary S7 live diagnostics.
# No installed-file or persistent-environment changes; no force termination.
param([int]$ExpectedMainPid = 4008, [int]$ExpectedHostPid = 15916)
$ErrorActionPreference = 'Stop'
$implementationRoot = 'E:\Do Something\DSH备份\dsh-session-index work\implementation-session-index'
$installedExecutable = 'E:\Program Files (x86)\DSH-D\DeepSeek Harness.exe'
$installedDirectory = 'E:\Program Files (x86)\DSH-D'
$evidenceDirectory = Join-Path $implementationRoot 'DEPLOYMENT_RESULTS'
$mainProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ExpectedMainPid"
$hostProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ExpectedHostPid"
if (!$mainProcess -or $mainProcess.ExecutablePath -ne $installedExecutable -or !$hostProcess -or
    $hostProcess.ExecutablePath -ne $installedExecutable -or $hostProcess.ParentProcessId -ne $ExpectedMainPid) {
  throw 'Expected installed Desktop identities do not match; no quit or restart performed'
}
$debugListener = @(Get-NetTCPConnection -State Listen -LocalPort 9229 -ErrorAction SilentlyContinue)
if ($debugListener.Count -ne 1 -or $debugListener[0].OwningProcess -ne $ExpectedMainPid -or
    $debugListener[0].LocalAddress -ne '127.0.0.1') { throw 'Expected loopback diagnostic listener does not match' }
foreach ($diagnosticVariable in @('NODE_OPTIONS','ELECTRON_RUN_AS_NODE')) {
  foreach ($environmentTarget in @('Process','User','Machine')) {
    if ([Environment]::GetEnvironmentVariable($diagnosticVariable, $environmentTarget)) {
      throw 'A diagnostic environment variable is present; ordinary startup not attempted'
    }
  }
}

& node (Join-Path $implementationRoot 'scripts\s7-live-inventory.mjs') --quit
if ($LASTEXITCODE -ne 0) { throw 'Graceful Desktop quit request failed' }
$deadline = [DateTime]::UtcNow.AddSeconds(45)
do {
  $allProcesses = @(Get-CimInstance Win32_Process)
  $installedProcesses = @($allProcesses | Where-Object { $_.ExecutablePath -eq $installedExecutable })
  $otherDshHosts = @($allProcesses | Where-Object {
    $_.ExecutablePath -ne $installedExecutable -and $_.CommandLine -and
    $_.CommandLine -match '(?:@deepseek-ai[\\/]dsh-(?:desktop-host|web)|[\\/]dsh[\\/]lib[\\/]bin\.js\s+(?:web|pluginlab))'
  })
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in @(19387,3080,9229,9230) })
  if (!$installedProcesses.Count -and !$otherDshHosts.Count -and !$listeners.Count) { break }
  Start-Sleep -Milliseconds 800
} while ([DateTime]::UtcNow -lt $deadline)
$stopRecord = [ordered]@{
  time = [DateTime]::UtcNow.ToString('o'); oldMainPid = $ExpectedMainPid; oldHostPid = $ExpectedHostPid
  installedProcessesRemaining = $installedProcesses.Count; otherDshHostsRemaining = $otherDshHosts.Count
  relevantListenersRemaining = $listeners.Count; forceTerminationUsed = $false
  stopped = (!$installedProcesses.Count -and !$otherDshHosts.Count -and !$listeners.Count)
}
$stopPath = Join-Path $evidenceDirectory ('LIVE_TEST_ORDINARY_STOP_' + [guid]::NewGuid().ToString('N') + '.json')
[IO.File]::WriteAllText($stopPath, ($stopRecord | ConvertTo-Json -Depth 6) + "`n", [Text.UTF8Encoding]::new($false))
if (!$stopRecord.stopped) { throw 'Writers did not all exit gracefully; ordinary startup not attempted' }
$ordinaryProcess = Start-Process -FilePath $installedExecutable -WorkingDirectory $installedDirectory -WindowStyle Normal -PassThru
$startRecord = [ordered]@{
  time = [DateTime]::UtcNow.ToString('o'); mode = 'ordinary-installed-desktop'; mainPid = $ordinaryProcess.Id
  executable = $installedExecutable; workingDirectory = $installedDirectory
  argumentListProvided = $false; diagnosticEnvironmentPresent = $false
  stopEvidence = $stopPath; forceTerminationUsed = $false
}
$startPath = Join-Path $evidenceDirectory ('LIVE_TEST_ORDINARY_START_' + [guid]::NewGuid().ToString('N') + '.json')
[IO.File]::WriteAllText($startPath, ($startRecord | ConvertTo-Json -Depth 6) + "`n", [Text.UTF8Encoding]::new($false))
$startRecord | ConvertTo-Json -Depth 6
