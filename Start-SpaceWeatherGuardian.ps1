$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 4173)

try {
    $listener.Start()
} catch {
    Write-Error "Could not start the local preview server on 127.0.0.1:4173. Close any other server using that port, then try again. $($_.Exception.Message)"
    exit 1
}

Write-Host 'SpaceWeather Guardian is running at http://127.0.0.1:4173/'
Write-Host 'Keep this window open while using the dashboard. Press Ctrl+C to stop.'

while ($listener.Server.IsBound) {
    $client = $null
    try {
        $client = $listener.AcceptTcpClient()
        $stream = $client.GetStream()
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
        $requestLine = $reader.ReadLine()
        if (-not $requestLine) { $client.Close(); continue }
        $parts = $requestLine.Split(' ')
        $requestPath = if ($parts.Length -gt 1) { [Uri]::UnescapeDataString(($parts[1] -split '\?')[0].TrimStart('/')) } else { '' }
        while ($reader.ReadLine() -ne '') { }

        if ([string]::IsNullOrWhiteSpace($requestPath)) { $requestPath = 'index.html' }
        $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $requestPath))
        if (-not $filePath.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -and $filePath -ne (Join-Path $root 'index.html')) {
            $status = '403 Forbidden'; $body = [System.Text.Encoding]::UTF8.GetBytes('Forbidden'); $contentType = 'text/plain; charset=utf-8'
        } elseif (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            $status = '404 Not Found'; $body = [System.Text.Encoding]::UTF8.GetBytes('Not found'); $contentType = 'text/plain; charset=utf-8'
        } else {
            $status = '200 OK'
            $body = [System.IO.File]::ReadAllBytes($filePath)
            $contentType = switch ([System.IO.Path]::GetExtension($filePath).ToLowerInvariant()) {
                '.html' { 'text/html; charset=utf-8' }
                '.css'  { 'text/css; charset=utf-8' }
                '.js'   { 'text/javascript; charset=utf-8' }
                '.json' { 'application/json; charset=utf-8' }
                '.svg'  { 'image/svg+xml' }
                default { 'application/octet-stream' }
            }
        }

        $header = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
        $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
        $stream.Write($headerBytes, 0, $headerBytes.Length)
        $stream.Write($body, 0, $body.Length)
        $stream.Flush()
    } catch {
        Write-Verbose $_.Exception.Message
    } finally {
        if ($client) { $client.Close() }
    }
}
