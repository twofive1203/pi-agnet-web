# Same-machine Electron / Tauri Preview runtime comparison (U8).
#
# This script records installer size, app-specific install dir, user data,
# shared WebView2, full process-tree Private Working Set / Commit, and
# optional cold/warm start. It never treats debug builds, uncompressed
# Cargo target trees, or Offline/Fixed WebView2 runtimes as qualification.
#
# Examples:
#   powershell -File scripts/benchmark-desktop-runtimes.ps1 -Scenario connected-idle
#   powershell -File scripts/benchmark-desktop-runtimes.ps1 -ElectronInstaller path\to\SnailPiPetSetup.exe -TauriInstaller path\to\preview-setup.exe
#
# Output defaults to desktop-tauri/.benchmark/ (gitignored).

[CmdletBinding()]
param(
    [ValidateSet("disconnected-idle", "connected-idle", "tray-open", "running-animation", "hidden-reconnecting")]
    [string]$Scenario = "connected-idle",
    [string]$ElectronProcessName = "snail-pi-pet",
    [string]$TauriProcessName = "snail-pi-pet-tauri-preview",
    [string]$ElectronInstaller,
    [string]$TauriInstaller,
    [string]$ElectronInstallDir,
    [string]$TauriInstallDir,
    [string]$ElectronUserData,
    [string]$TauriUserData,
    [string]$ElectronExe,
    [string]$TauriExe,
    [int]$SampleCount = 5,
    [int]$SampleIntervalMs = 1000,
    [int]$StartTimeoutMs = 15000,
    [switch]$LaunchForStartTiming,
    [string]$OutputDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) {
    $OutputDir = Join-Path $RepoRoot "desktop-tauri\.benchmark"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Get-FileSizeBytes([string]$PathValue) {
    if (-not $PathValue -or -not (Test-Path -LiteralPath $PathValue)) {
        return $null
    }
    return [int64](Get-Item -LiteralPath $PathValue).Length
}

function Get-DirectorySizeBytes([string]$PathValue) {
    if (-not $PathValue -or -not (Test-Path -LiteralPath $PathValue)) {
        return $null
    }
    $sum = 0L
    Get-ChildItem -LiteralPath $PathValue -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
        $sum += $_.Length
    }
    return $sum
}

function Format-Megabytes($bytes) {
    if ($null -eq $bytes) { return $null }
    return [math]::Round(($bytes / 1MB), 2)
}

function Test-ForbiddenQualificationPath([string]$PathValue, [string]$Label) {
    if (-not $PathValue) { return }
    $normalized = $PathValue.ToLowerInvariant().Replace("\", "/")
    if ($normalized -match "/target/debug/" -or $normalized -match "/desktop-tauri/src-tauri/target/" -and $normalized -notmatch "/bundle/") {
        throw "$Label must not use an uncompressed Cargo target tree as a release measurement: $PathValue"
    }
    if ($normalized -match "offlineinstaller" -or $normalized -match "fixedruntime" -or $normalized -match "webview2 fixed") {
        throw "$Label must not qualify Offline/Fixed WebView2 runtimes: $PathValue"
    }
}

function Get-WebView2Version {
    $candidates = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    foreach ($key in $candidates) {
        try {
            $pv = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).pv
            if ($pv) { return [string]$pv }
        } catch {
        }
    }
    return $null
}

function Get-ProcessTreeStats([string]$ProcessName) {
    $roots = @(Get-CimInstance Win32_Process -Filter "Name='$ProcessName.exe'" -ErrorAction SilentlyContinue)
    if (-not $roots -or $roots.Count -eq 0) {
        return $null
    }
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $byParent = @{}
    foreach ($proc in $all) {
        $parentId = [int]$proc.ParentProcessId
        if (-not $byParent.ContainsKey($parentId)) {
            $byParent[$parentId] = New-Object System.Collections.Generic.List[object]
        }
        $byParent[$parentId].Add($proc)
    }
    $queue = New-Object System.Collections.Generic.Queue[object]
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($root in $roots) {
        $queue.Enqueue($root)
        [void]$seen.Add([int]$root.ProcessId)
    }
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $children = $byParent[[int]$current.ProcessId]
        if ($children) {
            foreach ($child in $children) {
                if ($seen.Add([int]$child.ProcessId)) {
                    $queue.Enqueue($child)
                }
            }
        }
    }
    $privateBytes = 0L
    $commitBytes = 0L
    foreach ($processId in $seen) {
        try {
            $counter = Get-Process -Id $processId -ErrorAction Stop
            $privateBytes += [int64]$counter.WorkingSet64
            $commitBytes += [int64]$counter.PagedMemorySize64
        } catch {
        }
    }
    return [pscustomobject]@{
        processCount = $seen.Count
        privateWorkingSetBytes = $privateBytes
        commitBytes = $commitBytes
        pids = @($seen)
    }
}

function Get-Median($values) {
    $sorted = @($values | Sort-Object)
    if ($sorted.Count -eq 0) { return $null }
    $mid = [int][math]::Floor(($sorted.Count - 1) / 2)
    if ($sorted.Count % 2 -eq 1) { return $sorted[$mid] }
    return [math]::Round((($sorted[$mid] + $sorted[$mid + 1]) / 2.0), 0)
}

function Measure-ProcessTree([string]$ProcessName) {
    $samples = @()
    for ($i = 0; $i -lt $SampleCount; $i++) {
        $sample = Get-ProcessTreeStats -ProcessName $ProcessName
        if ($sample) { $samples += $sample }
        if ($i -lt $SampleCount - 1) {
            Start-Sleep -Milliseconds $SampleIntervalMs
        }
    }
    if ($samples.Count -eq 0) {
        return [pscustomobject]@{
            available = $false
            reason = "process not running: $ProcessName"
        }
    }
    return [pscustomobject]@{
        available = $true
        samples = $samples.Count
        processCount = ($samples | Select-Object -Last 1).processCount
        privateWorkingSetBytesMedian = Get-Median ($samples | ForEach-Object { $_.privateWorkingSetBytes })
        privateWorkingSetBytesMin = ($samples | Measure-Object -Property privateWorkingSetBytes -Minimum).Minimum
        privateWorkingSetBytesMax = ($samples | Measure-Object -Property privateWorkingSetBytes -Maximum).Maximum
        commitBytesMedian = Get-Median ($samples | ForEach-Object { $_.commitBytes })
    }
}

function Measure-StartMs([string]$ExePath, [string]$ProcessName) {
    if (-not $LaunchForStartTiming -or -not $ExePath) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $ExePath)) {
        throw "start-timing exe missing: $ExePath"
    }
    Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Process -FilePath $ExePath | Out-Null
    $deadline = [datetime]::UtcNow.AddMilliseconds($StartTimeoutMs)
    while ([datetime]::UtcNow -lt $deadline) {
        if (Get-Process -Name $ProcessName -ErrorAction SilentlyContinue) {
            $sw.Stop()
            return $sw.ElapsedMilliseconds
        }
        Start-Sleep -Milliseconds 50
    }
    throw "timed out waiting for $ProcessName after launching $ExePath"
}

Test-ForbiddenQualificationPath $ElectronInstaller "ElectronInstaller"
Test-ForbiddenQualificationPath $TauriInstaller "TauriInstaller"
Test-ForbiddenQualificationPath $ElectronInstallDir "ElectronInstallDir"
Test-ForbiddenQualificationPath $TauriInstallDir "TauriInstallDir"
Test-ForbiddenQualificationPath $ElectronExe "ElectronExe"
Test-ForbiddenQualificationPath $TauriExe "TauriExe"

$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$report = [ordered]@{
    generatedAt = [datetime]::UtcNow.ToString("o")
    scenario = $Scenario
    measurement = [ordered]@{
        memory = "full process-tree Private Working Set and Commit; median of $SampleCount samples"
        disk = "installer file, app-specific install dir, user data/cache; WebView2 Evergreen shared runtime listed separately"
        start = "optional cold launch to first host process; warm is a second launch after the first process is stopped"
        excluded = @(
            "desktop-tauri/src-tauri/target debug or uncompressed trees",
            "WebView2 Offline Installer",
            "WebView2 Fixed Runtime"
        )
    }
    machine = [ordered]@{
        computer = $env:COMPUTERNAME
        os = $os.Caption
        osVersion = $os.Version
        osBuild = $os.BuildNumber
        arch = $env:PROCESSOR_ARCHITECTURE
        cpu = $cpu.Name
        ramGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
        webView2 = Get-WebView2Version
    }
    targets = [ordered]@{
        installerMb = 20
        appDirMb = 30
        idlePrivateWorkingSetReduction = 0.30
    }
    electron = [ordered]@{}
    tauri = [ordered]@{}
    comparison = [ordered]@{}
    gate = [ordered]@{}
}

$report.electron.installerBytes = Get-FileSizeBytes $ElectronInstaller
$report.tauri.installerBytes = Get-FileSizeBytes $TauriInstaller
$report.electron.installDirBytes = Get-DirectorySizeBytes $ElectronInstallDir
$report.tauri.installDirBytes = Get-DirectorySizeBytes $TauriInstallDir
$report.electron.userDataBytes = Get-DirectorySizeBytes $ElectronUserData
$report.tauri.userDataBytes = Get-DirectorySizeBytes $TauriUserData
$report.electron.memory = Measure-ProcessTree -ProcessName $ElectronProcessName
$report.tauri.memory = Measure-ProcessTree -ProcessName $TauriProcessName

if ($LaunchForStartTiming) {
    $report.electron.coldStartMs = Measure-StartMs -ExePath $ElectronExe -ProcessName $ElectronProcessName
    $report.electron.warmStartMs = Measure-StartMs -ExePath $ElectronExe -ProcessName $ElectronProcessName
    $report.tauri.coldStartMs = Measure-StartMs -ExePath $TauriExe -ProcessName $TauriProcessName
    $report.tauri.warmStartMs = Measure-StartMs -ExePath $TauriExe -ProcessName $TauriProcessName
}

function Add-SizeComparison($name, $electronBytes, $tauriBytes, $limitMb) {
    $entry = [ordered]@{
        electronMb = Format-Megabytes $electronBytes
        tauriMb = Format-Megabytes $tauriBytes
        targetMb = $limitMb
    }
    if ($null -ne $tauriBytes) {
        $entry.tauriMeetsTarget = ([double]$tauriBytes / 1MB) -le $limitMb
    } else {
        $entry.tauriMeetsTarget = $null
        $entry.reason = "not measured"
    }
    $report.comparison[$name] = $entry
}

Add-SizeComparison "installer" $report.electron.installerBytes $report.tauri.installerBytes 20
Add-SizeComparison "appDir" $report.electron.installDirBytes $report.tauri.installDirBytes 30

$electronWs = $null
$tauriWs = $null
if ($report.electron.memory.available) { $electronWs = $report.electron.memory.privateWorkingSetBytesMedian }
if ($report.tauri.memory.available) { $tauriWs = $report.tauri.memory.privateWorkingSetBytesMedian }
$memory = [ordered]@{
    electronPrivateWorkingSetMb = Format-Megabytes $electronWs
    tauriPrivateWorkingSetMb = Format-Megabytes $tauriWs
    targetReduction = 0.30
}
if ($null -ne $electronWs -and $null -ne $tauriWs -and $electronWs -gt 0) {
    $reduction = [math]::Round((($electronWs - $tauriWs) / $electronWs), 4)
    $memory.observedReduction = $reduction
    $memory.meetsTarget = $reduction -ge 0.30
} else {
    $memory.observedReduction = $null
    $memory.meetsTarget = $null
    $memory.reason = "process-tree samples missing; do not infer a memory win"
}
$report.comparison.idleMemory = $memory

$missing = @()
foreach ($key in @("installer", "appDir")) {
    if ($null -eq $report.comparison[$key].tauriMeetsTarget) { $missing += $key }
}
if ($null -eq $report.comparison.idleMemory.meetsTarget) { $missing += "idleMemory" }

if ($missing.Count -gt 0) {
    $report.gate.decision = "Extend"
    $report.gate.reason = "automated contract can pass, but qualification evidence is incomplete: $($missing -join ', ')"
} elseif ($report.comparison.installer.tauriMeetsTarget -and $report.comparison.appDir.tauriMeetsTarget -and $report.comparison.idleMemory.meetsTarget) {
    $report.gate.decision = "Proceed-candidate"
    $report.gate.reason = "measured installer, app dir, and idle process-tree memory meet the published thresholds"
} elseif ($report.comparison.installer.tauriMeetsTarget -and $report.comparison.appDir.tauriMeetsTarget) {
    $report.gate.decision = "Extend"
    $report.gate.reason = "size targets met; idle process-tree memory did not reach a 30% reduction"
} else {
    $report.gate.decision = "Stop-or-Extend"
    $report.gate.reason = "measured size and/or memory missed the published thresholds; keep Electron as default"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$jsonPath = Join-Path $OutputDir "runtime-benchmark-$stamp.json"
$mdPath = Join-Path $OutputDir "runtime-benchmark-$stamp.md"
$json = $report | ConvertTo-Json -Depth 8
Set-Content -LiteralPath $jsonPath -Value $json -Encoding utf8

$md = @"
# Desktop runtime benchmark

- Generated: $($report.generatedAt)
- Scenario: $Scenario
- Machine: $($report.machine.computer) / $($report.machine.os) build $($report.machine.osBuild)
- CPU: $($report.machine.cpu)
- RAM: $($report.machine.ramGb) GB
- WebView2: $($report.machine.webView2)
- Memory method: $($report.measurement.memory)
- Disk method: $($report.measurement.disk)

| Metric | Electron | Tauri Preview | Target | Result |
| --- | --- | --- | --- | --- |
| Installer | $($report.comparison.installer.electronMb) MB | $($report.comparison.installer.tauriMb) MB | <= $($report.comparison.installer.targetMb) MB | $(if ($null -eq $report.comparison.installer.tauriMeetsTarget) { 'not measured' } elseif ($report.comparison.installer.tauriMeetsTarget) { 'pass' } else { 'miss' }) |
| App-specific dir | $($report.comparison.appDir.electronMb) MB | $($report.comparison.appDir.tauriMb) MB | <= $($report.comparison.appDir.targetMb) MB | $(if ($null -eq $report.comparison.appDir.tauriMeetsTarget) { 'not measured' } elseif ($report.comparison.appDir.tauriMeetsTarget) { 'pass' } else { 'miss' }) |
| Idle private WS | $($report.comparison.idleMemory.electronPrivateWorkingSetMb) MB | $($report.comparison.idleMemory.tauriPrivateWorkingSetMb) MB | >= 30% lower | $(if ($null -eq $report.comparison.idleMemory.meetsTarget) { 'not measured' } elseif ($report.comparison.idleMemory.meetsTarget) { 'pass' } else { 'miss' }) |

Gate suggestion: **$($report.gate.decision)** — $($report.gate.reason)

Do not treat this file as a Pass if any required row is "not measured".
"@
Set-Content -LiteralPath $mdPath -Value $md -Encoding utf8

Write-Output "BENCHMARK_OK json=$jsonPath"
Write-Output "BENCHMARK_OK markdown=$mdPath"
Write-Output "GATE=$($report.gate.decision)"
