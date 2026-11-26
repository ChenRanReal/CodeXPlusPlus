param(
    [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '../../.work/CodeXPlusPlus'),
    [ValidateSet('checking', 'desktop', 'renderer', 'blocked', 'failed', 'ready')]
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
        'Actions', 'RetryButton', 'CopyButton', 'Details', 'DiagnosticText')) {
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

function Set-LaunchView([string]$State, [string]$Diagnostic) {
    $script:latestState = $State
    switch ($State) {
        'checking' { $script:step = 0; $title = '正在檢查啟動環境'; $detail = '確認本機執行環境與 Codex Desktop。' }
        'desktop'  { $script:step = 1; $title = '正在啟動桌面'; $detail = '啟動 Codex Desktop，等待桌面 Controller。' }
        'renderer' { $script:step = 2; $title = '正在載入 CodeX++'; $detail = '等待桌面接上 Host 並載入擴充。' }
        'ready'    { $script:step = 3; $title = 'CodeX++ 已就緒'; $detail = 'Host 已連線，桌面擴充已載入。' }
        'blocked'  { $script:step = 1; $title = 'Codex 已經開啟'; $detail = $Diagnostic }
        'failed'   { $title = 'CodeX++ 啟動失敗'; $detail = '桌面擴充尚未就緒，可展開診斷查看原因。' }
    }
    $failed = $State -in @('blocked', 'failed')
    $view.StateTitle.Text = $title
    $view.StateDetail.Text = $detail
    $view.Actions.Visibility = if ($failed) { 'Visible' } else { 'Collapsed' }
    $view.Details.Visibility = if ($failed) { 'Visible' } else { 'Collapsed' }
    $view.Details.IsExpanded = $State -eq 'failed'
    $view.DiagnosticText.Text = $Diagnostic
    $view.CopyButton.Content = '複製診斷'
    $view.LaunchProgress.IsIndeterminate = !$failed -and $State -ne 'ready'
    $view.LaunchProgress.Value = if ($State -eq 'ready') { 100 } elseif ($failed) { $script:step * 33 } else { 0 }
    $view.LaunchProgress.Foreground = if ($failed) { Brush '#F1A37F' } else { Brush '#75EACB' }
    $marks = @($view.CheckMark, $view.DesktopMark, $view.RendererMark)
    for ($i = 0; $i -lt $marks.Count; $i++) {
        $mark = $marks[$i]
        if ($i -lt $script:step) {
            $mark.Text = '✓'
            $mark.Foreground = Brush '#75EACB'
        } elseif ($i -eq $script:step) {
            $mark.Text = if ($failed) { '!' } else { '●' }
            $mark.Foreground = if ($failed) { Brush '#F1A37F' } else { Brush '#BDB9FF' }
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

function Start-LaunchWorker {
    Set-LaunchView 'checking'
    if (Test-Path -LiteralPath $statusPath) { Remove-Item -LiteralPath $statusPath }
    if ($script:worker) { $script:worker.Dispose() }
    try {
        $start = [Diagnostics.ProcessStartInfo]::new($pwsh)
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        foreach ($argument in @('-NoLogo', '-NoProfile', '-File', $workerPath,
                '-RuntimeDirectory', $RuntimeDirectory, '-StatusPath', $statusPath)) {
            $start.ArgumentList.Add($argument)
        }
        $script:worker = [Diagnostics.Process]::Start($start)
        $poll.Start()
    } catch {
        Set-LaunchView 'failed' $_.Exception.Message
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
    if ($status -and $status.state -ne $script:latestState) {
        Set-LaunchView $status.state $status.detail
        if ($status.state -eq 'ready') {
            $poll.Stop()
            $script:desktopPid = $status.desktopPid
            try { Apply-ManagedDesktopIcon }
            catch { Write-Warning "桌面工作列圖示設定失敗：$($_.Exception.Message)" }
            $autoClose.Start()
            return
        }
        if ($status.state -in @('blocked', 'failed')) {
            $poll.Stop()
            return
        }
    }
    if ($script:worker -and $script:worker.HasExited -and $status.state -notin @('blocked', 'failed', 'ready')) {
        $poll.Stop()
        Set-LaunchView 'failed' "啟動程序提前結束（代碼 $($script:worker.ExitCode)）。"
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
$view.RetryButton.Add_Click({ if (!$Preview) { Start-LaunchWorker } })
$view.CopyButton.Add_Click({
    [Windows.Clipboard]::SetText($view.DiagnosticText.Text)
    $view.CopyButton.Content = '已複製'
})
$window.Add_ContentRendered({
    if ($Preview) {
        $diagnostic = switch ($Preview) {
            'blocked' { '請先從「檔案」選單完整退出目前的 Codex，再按「重試」。' }
            'failed'  { 'Codex Desktop exited before starting the codexhost Host chain' }
            default   { '' }
        }
        if ($Preview -eq 'failed') { Set-LaunchView 'renderer' }
        Set-LaunchView $Preview $diagnostic
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
    if (Test-Path -LiteralPath $statusPath) { Remove-Item -LiteralPath $statusPath -ErrorAction SilentlyContinue }
})
[void]$window.ShowDialog()
if ($CapturePath -and !$Preview) {
    [pscustomobject]@{ State = $script:latestState; DesktopPid = $script:desktopPid; DesktopIcon = $script:desktopIconApplied }
}
