$ErrorActionPreference = 'Stop'
$studioUrl = 'http://127.0.0.1:3210'
try {
    $studioReply = Invoke-RestMethod ($studioUrl + '/api/shutdown') -Method Post -Headers @{'X-Sonora'='1'} -ContentType 'application/json' -Body '{}' -TimeoutSec 5
    Write-Host $studioReply.message
} catch {
    Write-Host 'Sonora Studio is not reachable; it may already be stopped.'
}
