param(
    [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '../../.work/CodeXPlusPlus'),
    [ValidateSet('checking', 'desktop', 'renderer', 'blocked', 'failed', 'ready', 'running', 'confirm')]
    [string]$Preview,
    [string]$CapturePath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -Path (Join-Path $PSScriptRoot 'CodeXPlusPlusTaskbar.cs')

$xaml = Join-Path $PSScriptRoot 'CodeXPlusPlusLaunch.xaml'
$reader = [Xml.XmlReader]::Create($xaml)
try { $window = [Windows.Markup.XamlReader]::Load($reader) }
finally { $reader.Dispose() }

$iconPath = Join-Path $PSScriptRoot 'CodeXPlusPlus.ico'
$decoder = [Windows.Media.Imaging.IconBitmapDecoder]::new(
    [Uri]::new($iconPath), [Windows.Media.Imaging.BitmapCreateOptions]::None,
    [Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
$icon = $decoder.Frames | Sort-Object PixelWidth -Descending | Select-Object -First 1
$window.Icon = $icon
$view = @{}
foreach ($name in @('LaunchCard', 'Header', 'BrandImage', 'CloseButton', 'StateTitle',
        'StateDetail', 'CheckMark', 'DesktopMark', 'RendererMark', 'LaunchProgress',
        'ElapsedText', 'ActivityLog', 'ActivityScroll', 'Actions', 'RestartButton', 'DismissButton',
        'RetryButton', 'CopyButton', 'Details', 'DiagnosticText')) {
    $view[$name] = $window.FindName($name)
}
$view.BrandImage.Source = $icon
[Windows.Media.RenderOptions]::SetBitmapScalingMode($view.BrandImage, 'HighQuality')
$view.CloseButton.Add_Click({ $window.Close() })
$view.Header.Add_MouseLeftButtonDown({
    if ($_.OriginalSource -isnot [Windows.Controls.Button] -and
        $_.OriginalSource -isnot [Windows.Controls.Primitives.ButtonBase]) {
        try { $window.DragMove() } catch [InvalidOperationException] { }
    }
})

$pwsh = (Get-Process -Id $PID).Path
$scriptFile = $MyInvocation.MyCommand.Path
$openCommand = '"{0}" -NoLogo -NoProfile -Sta -WindowStyle Hidden -File "{1}" -RuntimeDirectory "{2}"' -f
    $pwsh, $scriptFile, $RuntimeDirectory
$shellIcon = "$iconPath,0"
$statusPath = Join-Path ([IO.Path]::GetTempPath()) "codex-plus-launch-$PID.json"
$workerPath = Join-Path $PSScriptRoot 'Invoke-CodeXPlusPlusLaunch.ps1'
$script:worker = $null
$script:latestState = ''
$script:latestFingerprint = ''
$script:launchMutex = $null
$script:launchMutexOwned = $false
$script:step = 0
$script:desktopPid = 0
$script:desktopIconApplied = $false
$poll = [Windows.Threading.DispatcherTimer]::new()
$poll.Interval = [TimeSpan]::FromMilliseconds(160)
$autoClose = [Windows.Threading.DispatcherTimer]::new()
$autoClose.Interval = [TimeSpan]::FromMilliseconds(1500)

function Brush([string]$Color) {
    [Windows.Media.SolidColorBrush]::new([Windows.Media.ColorConverter]::ConvertFromString($Color))
}

function Show-LaunchReminder([string]$State, [switch]$Quiet) {
    $window.Topmost = $true
    $null = $window.Activate()
    if ($Preview -or $Quiet) { return }
    if ($State -eq 'failed') { [System.Media.SystemSounds]::Hand.Play() }
    else { [System.Media.SystemSounds]::Asterisk.Play() }
}

function Enter-LaunchGate {
    if ($Preview -or $script:launchMutexOwned) { return $true }
    if (!$script:launchMutex) {
        $script:launchMutex = [Threading.Mutex]::new($false, 'Local\CodeXPlusPlusLaunch')
    }
    try {
        $script:launchMutexOwned = $script:launchMutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $script:launchMutexOwned = $true
    }
    return $script:launchMutexOwned
}

function Set-LaunchView([string]$State, [string]$Diagnostic, [string]$Log = '', [int]$Elapsed = 0) {
    $stateChanged = $script:latestState -ne $State
    $script:latestState = $State
    $stalled = $Diagnostic -like '这一步已经*'
    switch ($State) {
        'checking' { $script:step = 0; $title = '正在检查启动环境'; $detail = '确认本机文件与 Codex Desktop。' }
        'desktop'  { $script:step = 1; $title = '正在启动桌面'; $detail = '启动 Codex Desktop，等待桌面 Controller。' }
        'renderer' { $script:step = 2; $title = '正在加载 CodeX++'; $detail = '等待桌面接上 Host 并加载扩展。' }
        'ready'    { $script:step = 3; $title = 'CodeX++ 已就绪'; $detail = 'Host 已连上，桌面扩展已加载。' }
        'running'  {
            if ($Diagnostic -like '*启动窗口*') {
                $script:step = 0
                $title = '启动窗口已经打开'
            } else {
                $script:step = 3
                $title = 'CodeX++ 已经启动'
            }
            $detail = '不用再次打开。'
        }
        'confirm'  { $script:step = 1; $title = 'Codex 已经启动'; $detail = '要重新启动吗？重新启动会关闭之前已经打开的窗口。' }
        'blocked'  { $script:step = 1; $title = 'Codex 已经被启动'; $detail = $Diagnostic }
        'failed'   { $title = 'CodeX++ 启动失败'; $detail = '桌面扩展还没就绪。' }
    }
    if ($stalled) { $title = '这一步还没有新进展' }
    if ($Diagnostic) { $detail = $Diagnostic }
    $failed = $State -in @('blocked', 'failed')
    $remind = $State -in @('running', 'blocked', 'failed', 'confirm')
    $view.StateTitle.Text = $title
    $view.StateDetail.Text = $detail
    $view.ElapsedText.Text = '已等待 {0:mm\:ss}' -f [TimeSpan]::FromSeconds([Math]::Max($Elapsed, 0))
    if ($Log) { $view.ActivityLog.Text = $Log }
    $view.ActivityScroll.ScrollToEnd()
    $view.Actions.Visibility = if ($remind) { 'Visible' } else { 'Collapsed' }
    $view.RestartButton.Visibility = if ($State -eq 'confirm') { 'Visible' } else { 'Collapsed' }
    $view.DismissButton.Visibility = if ($State -in @('running', 'confirm')) { 'Visible' } else { 'Collapsed' }
    $view.DismissButton.Content = if ($State -eq 'confirm') { '取消' } else { '知道了' }
    $view.RetryButton.Visibility = if ($failed) { 'Visible' } else { 'Collapsed' }
    $view.Details.Visibility = if ($failed) { 'Visible' } else { 'Collapsed' }
    $view.Details.IsExpanded = $State -eq 'failed'
    $view.DiagnosticText.Text = $Diagnostic
    if ($view.CopyButton.Content -ne '已复制') { $view.CopyButton.Content = '复制当前状态' }
    $view.LaunchProgress.Foreground = if ($failed -or $stalled) { Brush '#F1A37F' } else { Brush '#75EACB' }
    if ($stateChanged) {
        $view.LaunchProgress.IsIndeterminate = $State -in @('checking', 'desktop', 'renderer')
        $view.LaunchProgress.Value = if ($State -in @('ready', 'running')) { 100 } elseif ($State -eq 'confirm') { 34 } elseif ($failed) { $script:step * 33 } else { 0 }
        if ($remind) { Show-LaunchReminder $State }
    }
    $marks = @($view.CheckMark, $view.DesktopMark, $view.RendererMark)
    for ($i = 0; $i -lt $marks.Count; $i++) {
        $mark = $marks[$i]
        if ($i -lt $script:step) {
            $mark.Text = '✓'
            $mark.Foreground = Brush '#75EACB'
        } elseif ($i -eq $script:step) {
            $mark.Text = if ($failed -or $stalled) { '!' } else { '●' }
            $mark.Foreground = if ($failed -or $stalled) { Brush '#F1A37F' } else { Brush '#BDB9FF' }
        } else {
            $mark.Text = '○'
            $mark.Foreground = Brush '#7C8AA4'
        }
    }
}

function Save-LaunchCapture {
    $card = $view.LaunchCard
    $card.UpdateLayout()
    $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(
        [int][Math]::Ceiling($card.ActualWidth), [int][Math]::Ceiling($card.ActualHeight),
        96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($card)
    $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Create([IO.Path]::GetFullPath($CapturePath))
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
}

function Start-LaunchWorker([switch]$ReplaceExisting) {
    $script:latestFingerprint = ''
    $window.Topmost = $false
    if (!(Enter-LaunchGate)) {
        Set-LaunchView 'running' '启动窗口已经打开。请查看正在显示的那个 CodeX++ 启动窗口。' '00:00  重复打开：启动窗口已经在运行' 0
        return
    }
    Set-LaunchView 'checking' '' "00:00  正在确认本机文件与 Codex Desktop" 0
    if (Test-Path -LiteralPath $statusPath) { Remove-Item -LiteralPath $statusPath }
    if ($script:worker) { $script:worker.Dispose() }
    try {
        $start = [Diagnostics.ProcessStartInfo]::new($pwsh)
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $workerArguments = @('-NoLogo', '-NoProfile', '-File', $workerPath,
            '-RuntimeDirectory', $RuntimeDirectory, '-StatusPath', $statusPath)
        if ($ReplaceExisting) { $workerArguments += '-ReplaceExisting' }
        foreach ($argument in $workerArguments) {
            $start.ArgumentList.Add($argument)
        }
        $script:worker = [Diagnostics.Process]::Start($start)
        $poll.Start()
    } catch {
        Set-LaunchView 'failed' $_.Exception.Message $_.Exception.Message
    }
}

function Apply-ManagedDesktopIcon {
    $desktop = Get-Process -Id $script:desktopPid -ErrorAction SilentlyContinue
    if ($desktop.Path -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -or
        $desktop.MainWindowHandle -eq [IntPtr]::Zero) { return }
    [CodeXPlusPlusTaskbar]::Apply($desktop.MainWindowHandle, $openCommand, $shellIcon)
    $script:desktopIconApplied =
        [CodeXPlusPlusTaskbar]::GetIconResource($desktop.MainWindowHandle) -eq $shellIcon
}

$window.Add_SourceInitialized({
    if ($Preview) { return }
    $handle = [Windows.Interop.WindowInteropHelper]::new($window).Handle
    try { [CodeXPlusPlusTaskbar]::Apply($handle, $openCommand, $shellIcon) }
    catch { Write-Warning "工作列圖示設定失敗：$($_.Exception.Message)" }
})
$poll.Add_Tick({
    $status = $null
    if (Test-Path -LiteralPath $statusPath) {
        try { $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json }
        catch { return }
    }
    if ($status) {
        $fingerprint = "$($status.state)|$($status.detail)|$($status.elapsed)|$($status.log)"
        if ($fingerprint -ne $script:latestFingerprint) {
            $script:latestFingerprint = $fingerprint
            Set-LaunchView $status.state $status.detail $status.log ([int]$status.elapsed)
        }
        if ($status.state -eq 'ready' -and $script:latestState -eq 'ready') {
            $poll.Stop()
            $script:desktopPid = $status.desktopPid
            try { Apply-ManagedDesktopIcon }
            catch { Write-Warning "桌面工作列圖示設定失敗：$($_.Exception.Message)" }
            $autoClose.Start()
            return
        }
        if ($status.state -eq 'confirm' -and $script:latestState -eq 'confirm') {
            $poll.Stop()
            $script:desktopPid = $status.desktopPid
            return
        }
        if ($status.state -eq 'running' -and $script:latestState -eq 'running') {
            $poll.Stop()
            $script:desktopPid = $status.desktopPid
            try { Apply-ManagedDesktopIcon }
            catch { Write-Warning "桌面工作列圖示設定失敗：$($_.Exception.Message)" }
            if ($script:desktopPid) {
                $shell = New-Object -ComObject WScript.Shell
                [void]$shell.AppActivate($script:desktopPid)
            }
            Show-LaunchReminder 'running' -Quiet
            return
        }
        if ($status.state -in @('blocked', 'failed')) {
            $poll.Stop()
            return
        }
    }
    if ($script:worker -and $script:worker.HasExited -and $status.state -notin @('blocked', 'failed', 'ready')) {
        $poll.Stop()
        Set-LaunchView 'failed' "启动程序提前结束（代码 $($script:worker.ExitCode)）。" $view.ActivityLog.Text
    }
})
$autoClose.Add_Tick({
    $autoClose.Stop()
    if ($CapturePath) { Save-LaunchCapture }
    if ($script:desktopPid) {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate($script:desktopPid)
    }
    $window.Close()
})
$view.DismissButton.Add_Click({
    if ($script:desktopPid) {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate($script:desktopPid)
    }
    $window.Close()
})
$view.RestartButton.Add_Click({ if (!$Preview) { Start-LaunchWorker -ReplaceExisting } })
$view.RetryButton.Add_Click({ if (!$Preview) { Start-LaunchWorker } })
$view.CopyButton.Add_Click({
    $copied = @($view.ActivityLog.Text, $view.DiagnosticText.Text) | Where-Object { $_ } 
    [Windows.Clipboard]::SetText(($copied -join "`r`n"))
    $view.CopyButton.Content = '已复制'
})
$window.Add_ContentRendered({
    if ($Preview) {
        $diagnostic = switch ($Preview) {
            'desktop' { '这一步已经 13 秒没有新进展：正在创建 Codex Desktop 进程' }
            'renderer' { '等待桌面接上 Host；扩展状态：加载中' }
            'running' { '启动窗口已经打开。请查看正在显示的那个 CodeX++ 启动窗口。' }
            'confirm' { '要重新启动吗？重新启动会关闭之前已经打开的窗口。' }
            'blocked' { 'Codex 已经被启动。请先退出当前窗口，再打开 CodeX++。' }
            'failed'  { '启动失败。Codex 桌面在接上 Host 之前就退出了。' }
            default   { '正在确认本机文件与 Codex Desktop。' }
        }
        $log = "00:00  正在确认本机文件与 Codex Desktop`n00:02  已找到 Codex Desktop`n00:03  正在创建 Codex Desktop 进程`n00:16  仍停在这一步，已 13 秒没有新进展"
        if ($Preview -eq 'failed') { Set-LaunchView 'renderer' $diagnostic $log 16 }
        Set-LaunchView $Preview $diagnostic $log $(if ($Preview -eq 'ready') { 21 } else { 16 })
        if ($CapturePath) {
            $window.Dispatcher.BeginInvoke([Action]{
                Save-LaunchCapture
                $window.Close()
            }, [Windows.Threading.DispatcherPriority]::ApplicationIdle) | Out-Null
        }
    } else {
        Start-LaunchWorker
    }
})
$window.Add_Closed({
    $poll.Stop()
    $autoClose.Stop()
    if ($script:worker) { $script:worker.Dispose() }
    if ($script:launchMutex) {
        if ($script:launchMutexOwned) {
            try { $script:launchMutex.ReleaseMutex() } catch { }
        }
        $script:launchMutex.Dispose()
        $script:launchMutex = $null
        $script:launchMutexOwned = $false
    }
    if (Test-Path -LiteralPath $statusPath) { Remove-Item -LiteralPath $statusPath -ErrorAction SilentlyContinue }
})
[void]$window.ShowDialog()
if ($CapturePath -and !$Preview) {
    [pscustomobject]@{ State = $script:latestState; DesktopPid = $script:desktopPid; DesktopIcon = $script:desktopIconApplied }
}
