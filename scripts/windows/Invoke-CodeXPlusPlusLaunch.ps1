param(
    [Parameter(Mandatory)][string]$RuntimeDirectory,
    [Parameter(Mandatory)][string]$StatusPath
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

function Write-LaunchStatus([string]$State, [string]$Detail = '', [int]$DesktopPid = 0) {
    $payload = @{ state = $State; detail = $Detail; desktopPid = $DesktopPid } |
        ConvertTo-Json -Compress
    $next = "$StatusPath.next"
    [IO.File]::WriteAllText($next, $payload)
    [IO.File]::Move($next, $StatusPath, $true)
}

function Get-DesktopRoots {
    Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -OperationTimeoutSec 4 |
        Where-Object {
            $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -and
            $_.CommandLine -notmatch '(?:^|\s)--type='
        }
}

try {
    Write-LaunchStatus 'checking'
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

    if ($desktopRoots.Count) {
        $descriptor = Read-LaunchJson $descriptorPath
        $diagnostics = Read-LaunchJson $controllerPath
        $ready = (Read-LaunchJson $startupPath).records |
            Where-Object { $_.pid -eq $descriptor.launcher_pid -and $_.outcome -eq 'ready' } |
            Select-Object -First 1
        if ($ready -and $diagnostics.renderer.state -eq 'installed') {
            $owner = Get-Process -Id $ready.pid -ErrorAction SilentlyContinue
            $control = Get-Process -Id $diagnostics.pid -ErrorAction SilentlyContinue
            $owned = $desktopRoots | Where-Object ParentProcessId -eq $ready.pid | Select-Object -First 1
            if ($owner.Path -eq $launcher -and $control.Path -eq $node -and $owned) {
                Write-LaunchStatus 'ready' '' $owned.ProcessId
                return
            }
        }
        Write-LaunchStatus 'blocked' '請先從「檔案」選單完整退出目前的 Codex，再按「重試」。'
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
    do {
        $record = (Read-LaunchJson $startupPath).records |
            Where-Object { $_.pid -eq $process.Id -and $_.startedAtMs -ge $launchRequestedAt } |
            Select-Object -First 1
        $diagnostics = Read-LaunchJson $controllerPath
        if ($diagnostics.startedAt -ge $launchRequestedAt) {
            if (!$controllerReported) {
                Write-LaunchStatus 'renderer'
                $controllerReported = $true
            }
            if ($record.outcome -eq 'ready' -and $diagnostics.renderer.state -eq 'installed') {
                $owned = Get-DesktopRoots | Where-Object ParentProcessId -eq $process.Id | Select-Object -First 1
                if ($owned) {
                    Write-LaunchStatus 'ready' '' $owned.ProcessId
                    return
                }
            }
        }
        if ($process.HasExited -or $record.outcome -eq 'failed') {
            if ($record.error) { throw $record.error }
            throw "CodeX++ 啟動程序提前結束（代碼 $($process.ExitCode)）。"
        }
        Start-Sleep -Milliseconds 300
    } while ($deadline.Elapsed.TotalSeconds -lt 120)
    throw '等待桌面接上 Host 或載入 CodeX++ 擴充時逾時。'
} catch {
    Write-LaunchStatus 'failed' $_.Exception.Message
    exit 1
}
