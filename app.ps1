<#
    Launch the chat UI as a windowed app.

    Starts serve.py if it is not already running, waits for it to actually be
    ready, then opens the UI in a Chromium-family browser using --app= so there
    is no address bar, no tabs, and a taskbar entry of its own.

    No new dependencies. The UI already handles drag & drop and clipboard paste;
    all this adds is a window and process management.

    Note there will be two windows: this one, and the Playwright browser that
    holds the Copilot session and does the actual work. That is inherent to the
    design, not an oversight. Closing the app window stops the server, which
    closes the other one too.

        .\app.ps1              open the app
        .\app.ps1 -KeepServer  leave the server running after the window closes
        .\app.ps1 -ProfileDir .profile-personal
#>
[CmdletBinding()]
param(
    [int]$Port = 8790,
    [string]$ProfileDir,
    [switch]$KeepServer,
    [int]$ReadyTimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
$url = "http://127.0.0.1:$Port/"

if (-not (Test-Path $python)) {
    Write-Host "No venv at $python" -ForegroundColor Red
    Write-Host "Run:  python -m venv .venv; .\.venv\Scripts\python.exe -m pip install playwright flask"
    exit 1
}

function Test-ServerReady {
    try {
        $r = Invoke-RestMethod -Uri "${url}health" -TimeoutSec 3
        return $r.status -eq 'ready'
    } catch { return $false }
}

function Test-PortBusy {
    [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

# --- server ---------------------------------------------------------------

$startedServer = $false
if (Test-PortBusy) {
    Write-Host "Server already on port $Port, reusing it." -ForegroundColor DarkGray
} else {
    $logDir = Join-Path $root 'logs'
    New-Item -ItemType Directory -Force $logDir | Out-Null
    $log = Join-Path $logDir 'serve.log'

    $serveArgs = @((Join-Path $root 'serve.py'), '--port', $Port)
    if ($ProfileDir) { $serveArgs += @('--profile', $ProfileDir) }

    Write-Host "Starting server... (log: $log)" -ForegroundColor DarkGray
    $server = Start-Process -FilePath $python -ArgumentList $serveArgs `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $startedServer = $true
}

# Wait on the health endpoint rather than a fixed sleep: the first run has to
# launch Chromium and confirm the profile still holds a session.
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
$spin = '|/-\'; $i = 0
while (-not (Test-ServerReady)) {
    if ((Get-Date) -gt $deadline) {
        Write-Host "`nServer never became ready. Check logs\serve.log" -ForegroundColor Red
        Write-Host "If this is a fresh profile you must sign in once:" -ForegroundColor Yellow
        Write-Host "  .\.venv\Scripts\python.exe capture.py --label signin --seconds 300"
        exit 1
    }
    if ($startedServer -and $server.HasExited) {
        Write-Host "`nServer exited immediately. Last lines of the log:" -ForegroundColor Red
        if (Test-Path $log) { Get-Content $log -Tail 15 }
        if (Test-Path "$log.err") { Get-Content "$log.err" -Tail 15 }
        exit 1
    }
    Write-Host "`r  waiting for the browser to come up $($spin[$i++ % 4])" -NoNewline
    Start-Sleep -Milliseconds 500
}
Write-Host "`r  ready.                                   " -ForegroundColor Green

# --- browser --------------------------------------------------------------

# Any Chromium-family browser will do; Edge is always present on Windows 11, so
# the fallback chain never comes up empty. Playwright's own Chromium is the last
# resort since we know it is installed.
$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) {
    $browser = Get-ChildItem "$env:LOCALAPPDATA\ms-playwright\chromium-*\chrome-win\chrome.exe" `
        -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $browser) {
    Write-Host "No Chromium-family browser found. Open $url yourself." -ForegroundColor Yellow
    exit 1
}

# A dedicated user-data-dir matters: without it --app can be absorbed into an
# already-running Chrome, which then owns the window and exits immediately,
# so the wait below would return instantly and kill the server.
$windowProfile = Join-Path $root '.appwindow'
$browserArgs = @(
    "--app=$url",
    "--user-data-dir=$windowProfile",
    '--window-size=1280,940',
    '--no-first-run',
    '--no-default-browser-check'
)

Write-Host "Opening $url in $(Split-Path -Leaf $browser)" -ForegroundColor DarkGray
$app = Start-Process -FilePath $browser -ArgumentList $browserArgs -PassThru

# --- teardown -------------------------------------------------------------

if ($KeepServer) {
    Write-Host "Window opened. Server left running (-KeepServer)." -ForegroundColor DarkGray
    exit 0
}

Write-Host "Close the app window to shut everything down." -ForegroundColor DarkGray
$app.WaitForExit()

if ($startedServer) {
    Write-Host "Stopping server..." -ForegroundColor DarkGray
    try { Stop-Process -Id $server.Id -Force -ErrorAction Stop } catch {}
    # serve.py owns a Playwright Chromium; killing the parent can orphan it.
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $($server.Id)" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Write-Host "Done." -ForegroundColor Green
