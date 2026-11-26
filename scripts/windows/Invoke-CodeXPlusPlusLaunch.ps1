param(
    [Parameter(Mandatory)][string]$RuntimeDirectory,
    [Parameter(Mandatory)][string]$StatusPath,
    [switch]$ReplaceExisting
)

$ErrorActionPreference = 'Stop'

function Read-LaunchJson([string]$Path) {
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            Get-Content -Raw -Encoding utf8 -LiteralPath $Path | ConvertFrom-Json
        }
    } catch {
        # A supervisor can replace its diagnostic file during a launch.
        return $null
    }
}

$script:statusStarted = [Diagnostics.Stopwatch]::StartNew()
$script:statusLog = [Collections.Generic.List[string]]::new()
$script:statusStage = ''
$script:statusStageSince = [Diagnostics.Stopwatch]::StartNew()

function Format-LaunchStage([string]$Name) {
    switch -Wildcard ($Name) {
        'launch requested' { '已接到启动请求' }
        'resources resolved' { '本机启动文件已确认' }
        'Codex Desktop installation discovered' { '已找到 Codex Desktop' }
        'acquiring Launcher ownership' { '正在取得启动器所有权' }
        'Launcher ownership acquired' { '已取得启动器所有权' }
        'attached to existing controlled Desktop' { '已接上正在运行的 CodeX++' }
        'launching Codex Desktop*' { '正在创建 Codex Desktop 进程' }
        'Codex Desktop launched' { 'Codex Desktop 进程已创建' }
        'spawning Desktop Controller' { '正在启动桌面 Controller' }
        'waiting for Desktop Controller readiness' { '等待桌面 Controller 就绪' }
        'Desktop Controller ready' { '桌面 Controller 已就绪' }
        'waiting for Host chain' { '等待桌面接上 Host' }
        'Host chain ready' { 'Host 已接上' }
        'runtime descriptor published' { '运行信息已发布' }
        'publishing ready' { '正在确认扩展已加载' }
        'Host chain wait ended early*' { 'Host 等待提前结束' }
        'stopping Desktop Controller' { '正在停止桌面 Controller' }
        'Desktop Controller stopped' { '桌面 Controller 已停止' }
        'retrying Codex Desktop*' { '正在重试启动 Codex Desktop' }
        default { if ($Name) { $Name } else { '启动程序已运行，正在查找 Codex Desktop' } }
    }
}

function Add-StatusLine([string]$Text) {
    $stamp = '{0:mm\:ss}' -f $script:statusStarted.Elapsed
    $line = "$stamp  $Text"
    if ($script:statusLog.Count -gt 0 -and $script:statusLog[$script:statusLog.Count - 1] -eq $line) { return }
    $script:statusLog.Add($line)
    while ($script:statusLog.Count -gt 8) { $script:statusLog.RemoveAt(0) }
}

function Write-LaunchStatus([string]$State, [string]$Detail = '', [int]$DesktopPid = 0, [string]$Stage = '') {
    $stageText = if ($Stage) {
        Format-LaunchStage $Stage
    } elseif ($Detail) {
        $Detail.TrimEnd('。')
    } else {
        '启动程序已运行，正在查找 Codex Desktop'
    }
    if ($stageText -ne $script:statusStage) {
        $script:statusStage = $stageText
        $script:statusStageSince.Restart()
        Add-StatusLine $stageText
    }
    $quietSeconds = [int]$script:statusStageSince.Elapsed.TotalSeconds
    $waiting = $State -in @('checking', 'desktop', 'renderer')
    if ($waiting -and $quietSeconds -ge 12 -and $quietSeconds % 5 -eq 0) {
        Add-StatusLine "仍停在这一步，已 $quietSeconds 秒没有新进展"
    }
    if ($waiting -and $quietSeconds -ge 12) {
        $Detail = "这一步已经 $quietSeconds 秒没有新进展：$stageText"
    } elseif (!$Detail) {
        $Detail = $stageText
    }
    $payload = @{
        state = $State
        detail = $Detail
        desktopPid = $DesktopPid
        elapsed = [int]$script:statusStarted.Elapsed.TotalSeconds
        stage = $stageText
        log = ($script:statusLog -join "`n")
    } | ConvertTo-Json -Compress
    $next = "$StatusPath.next"
    [IO.File]::WriteAllText($next, $payload)
    [IO.File]::Move($next, $StatusPath, $true)
}

function Convert-LaunchReminder([string]$Message) {
    if ($Message -like 'Codex 已经被启动*' -or $Message -like '启动失败*') { return $Message }
    switch -Wildcard ($Message) {
        '*already running*' { 'Codex 已经被启动。请先退出当前窗口，再打开 CodeX++。' }
        '*exited before starting*' { '启动失败。Codex 桌面在接上 Host 之前就退出了。' }
        '*could not terminate*' { '启动失败。Codex 已经被启动，而且当前无法关闭它。' }
        '*存取被拒*' { '启动失败。Codex 已经被启动，而且当前无法关闭它。' }
        '*Access is denied*' { '启动失败。Codex 已经被启动，而且当前无法关闭它。' }
        '*超时*' { '启动失败。等待桌面接上 Host 超时。' }
        default { "启动失败。$Message" }
    }
}

function Get-StoreDesktops {
    Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -OperationTimeoutSec 4 |
        Where-Object { $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' }
}

function Get-DesktopRoots {
    Get-StoreDesktops | Where-Object { $_.CommandLine -notmatch '(?:^|\s)--type=' }
}

function Stop-ExistingDesktop {
    $roots = @(Get-DesktopRoots)
    $launcherIds = @($roots | ForEach-Object { $_.ParentProcessId } | Select-Object -Unique)
    foreach ($root in $roots) {
        $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ((@(Get-DesktopRoots)).Count -and $deadline.Elapsed.TotalSeconds -lt 8) {
        Start-Sleep -Milliseconds 300
    }
    foreach ($process in @(Get-StoreDesktops)) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($launcherId in $launcherIds) {
        $launcherProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$launcherId" -ErrorAction SilentlyContinue
        if ($launcherProcess.Name -ne 'codexhost.exe' -or $launcherProcess.CommandLine -notmatch '(?:^|\s)launch(?:\s|$)') {
            continue
        }
        $wait = [Diagnostics.Stopwatch]::StartNew()
        while ((Get-Process -Id $launcherId -ErrorAction SilentlyContinue) -and $wait.Elapsed.TotalSeconds -lt 5) {
            Start-Sleep -Milliseconds 200
        }
        if (Get-Process -Id $launcherId -ErrorAction SilentlyContinue) {
            Stop-Process -Id $launcherId -Force -ErrorAction SilentlyContinue
        }
    }
    if (@(Get-DesktopRoots).Count) {
        throw (Convert-LaunchReminder 'could not terminate existing Codex')
    }
}

try {
    Write-LaunchStatus 'checking' '正在确认本机文件与 Codex Desktop。'
    $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
    $launcher = Join-Path $root 'target/debug/codexhost.exe'
    $node = Join-Path $RuntimeDirectory 'node24/node.exe'
    $shim = Join-Path $root 'target/debug/codexhost-shim.exe'
    $runtime = Join-Path $root 'packages/host-runtime/dist/main.js'
    $controller = Join-Path $root 'packages/desktop-control/dist/release-main.js'
    $renderer = Join-Path $root 'packages/renderer-extension/dist/production.js'
    foreach ($file in @($launcher, $node, $shim, $runtime, $controller, $renderer)) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "找不到啟動檔案 $file" }
    }

    $env:CODEXHOST_DATA_DIR = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codexhost-lite'
    $env:CODEXHOST_WEB_SERVICE = '0'
    $env:CODEXHOST_CONSOLE = '0'
    $env:PATH = (Split-Path -Parent $node) + [IO.Path]::PathSeparator + $env:PATH
    $startupPath = Join-Path $env:CODEXHOST_DATA_DIR 'diagnostics/launcher-startup-v1.json'
    $controllerPath = Join-Path $env:CODEXHOST_DATA_DIR 'diagnostics/desktop-controller-v1.json'
    $descriptorPath = Join-Path $env:LOCALAPPDATA 'codexhost/desktop-runtime-v1.json'
    $desktopRoots = @(Get-DesktopRoots)
    if ($ReplaceExisting -and $desktopRoots.Count) {
        Write-LaunchStatus 'desktop' '正在关闭之前已经打开的窗口。'
        Stop-ExistingDesktop
        $desktopRoots = @()
    }

    if ($desktopRoots.Count) {
        Write-LaunchStatus 'confirm' '要重新启动吗？重新启动会关闭之前已经打开的窗口。' $desktopRoots[0].ProcessId
        return
    }

    Write-LaunchStatus 'desktop'
    $traceRequest = Join-Path $RuntimeDirectory 'trace-next-launch'
    if (Test-Path -LiteralPath $traceRequest -PathType Leaf) {
        $traceScript = Join-Path $RuntimeDirectory 'Watch-DesktopLaunch.ps1'
        $traceOutput = Join-Path $RuntimeDirectory "desktop-launch-$PID.jsonl"
        $traceArguments = @('-NoLogo', '-NoProfile', '-File', ('"' + $traceScript + '"'),
            '-LogPath', ('"' + $traceOutput + '"'), '-Seconds', '120')
        try {
            Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList $traceArguments -WindowStyle Hidden
            Remove-Item -LiteralPath $traceRequest
        } catch {
            Write-Warning 'CodeX++ 啟動追蹤未能開始。'
        }
    }
    $launchArguments = @(
        'launch',
        '--windows-direct',
        '--shim', ('"' + $shim + '"'),
        '--node', ('"' + $node + '"'),
        '--host-runtime', ('"' + $runtime + '"'),
        '--desktop-controller', ('"' + $controller + '"'),
        '--renderer', ('"' + $renderer + '"')
    )
    $launchRequestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $process = Start-Process -FilePath $launcher -ArgumentList $launchArguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    $controllerReported = $false
        $lastPublished = [DateTime]::MinValue
    $publishedStage = ''
    do {
        $record = (Read-LaunchJson $startupPath).records |
            Where-Object { $_.pid -eq $process.Id -and $_.startedAtMs -ge $launchRequestedAt } |
            Select-Object -First 1
        $diagnostics = Read-LaunchJson $controllerPath
        $stage = if ($record.stages) { [string]$record.stages[-1].name } else { '' }
        $phase = 'desktop'
        $rendererNote = ''
        if ($diagnostics.startedAt -ge $launchRequestedAt) {
            $phase = 'renderer'
            $rendererState = [string]$diagnostics.renderer.state
            $rendererNote = if ($rendererState -eq 'installed') { '扩展已加载' } elseif ($rendererState) { "扩展状态：$rendererState" } else { '扩展尚未回报' }
            if ($diagnostics.renderer.lastError) { $rendererNote = "$rendererNote；$($diagnostics.renderer.lastError)" }
            if (!$controllerReported) { $controllerReported = $true }
            if ($record.outcome -eq 'ready' -and $rendererState -eq 'installed') {
                $owned = Get-DesktopRoots | Where-Object ParentProcessId -eq $process.Id | Select-Object -First 1
                if ($owned) {
                    Write-LaunchStatus 'ready' 'Host 已连上，桌面扩展已加载。' $owned.ProcessId $stage
                    return
                }
                $rendererNote = 'Host 已就绪，正在确认桌面窗口'
            }
        }
        $detail = if ($rendererNote -and $stage) { "$(Format-LaunchStage $stage)；$rendererNote" } elseif ($rendererNote) { $rendererNote } else { '' }
        if ($stage -ne $publishedStage -or ((Get-Date) - $lastPublished).TotalMilliseconds -ge 900) {
            Write-LaunchStatus $phase $detail 0 $stage
            $publishedStage = $stage
            $lastPublished = Get-Date
        }
        if ($process.HasExited -or $record.outcome -eq 'failed') {
            if ($record.error) { throw (Convert-LaunchReminder $record.error) }
            throw (Convert-LaunchReminder "启动程序提前结束（代码 $($process.ExitCode)）。")
        }
        Start-Sleep -Milliseconds 300
    } while ($deadline.Elapsed.TotalSeconds -lt 120)
    throw (Convert-LaunchReminder '等待桌面接上 Host 或加载 CodeX++ 扩展时超时。')
} catch {
    $reminder = Convert-LaunchReminder $_.Exception.Message
    $state = if ($reminder -like 'Codex 已经被启动*') { 'blocked' } else { 'failed' }
    Write-LaunchStatus $state $reminder
    exit 1
}
