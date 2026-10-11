$ErrorActionPreference = 'Stop'
$studioRoot = $PSScriptRoot
$studioUrl = 'http://127.0.0.1:3210'
function Open-StudioBrowser {
    $browser = New-Object System.Diagnostics.ProcessStartInfo
    $browser.FileName = $studioUrl
    $browser.UseShellExecute = $true
    try { [System.Diagnostics.Process]::Start($browser) | Out-Null }
    catch { Write-Host ('Sonora Studio is running. Open: ' + $studioUrl) }
}
try {
    $studioState = Invoke-RestMethod ($studioUrl + '/api/state') -TimeoutSec 2
    if ($null -ne $studioState.health) { Open-StudioBrowser; exit 0 }
} catch {}
$studioNode = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $studioNode) { throw 'Node.js 22 or newer was not found. Install Node.js and try again.' }
$studioMajor = [int]((& $studioNode.Source --version).TrimStart('v').Split('.')[0])
if ($studioMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
$studioProcess = New-Object System.Diagnostics.ProcessStartInfo
$studioProcess.FileName = $studioNode.Source
$studioProcess.Arguments = 'server.mjs'
$studioProcess.WorkingDirectory = $studioRoot
$studioProcess.UseShellExecute = $true
$studioProcess.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
[System.Diagnostics.Process]::Start($studioProcess) | Out-Null
for ($studioAttempt = 0; $studioAttempt -lt 30; $studioAttempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $studioState = Invoke-RestMethod ($studioUrl + '/api/state') -TimeoutSec 2
        if ($null -ne $studioState.health) { Open-StudioBrowser; exit 0 }
    } catch {}
}
throw ('Sonora Studio did not start. Open a terminal in ' + $studioRoot + ' and run node server.mjs to see the error.')
