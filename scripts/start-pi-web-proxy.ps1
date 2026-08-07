# Start Snail Pi Web with proxy settings that Node/Next can actually use.
#
# Usage:
#   .\scripts\start-pi-web-proxy.ps1
#   .\scripts\start-pi-web-proxy.ps1 -Server
#   .\scripts\start-pi-web-proxy.ps1 -Server -NoOpen
#   .\scripts\start-pi-web-proxy.ps1 -Dev
#   .\scripts\start-pi-web-proxy.ps1 -Server -Port 8080
#   .\scripts\start-pi-web-proxy.ps1 -Server -AuthBypassCidrs "100.64.0.0/10"
#   .\scripts\start-pi-web-proxy.ps1 -Server -AllowInsecureHttp  # trusted encrypted mesh only
#
# Tailscale / phone (recommended durable config, no env needed each time):
#   1) Write %USERPROFILE%\.pi\agent\server-access-policy.json
#        { "version": 1, "authBypassCidrs": ["100.64.0.0/10"] }
#   2) .\scripts\start-pi-web-proxy.ps1 -Server -NoOpen
#
# Optional env overrides (still supported):
#   $env:PROXY_URL = "http://127.0.0.1:7897"
#   $env:SOCKS_PROXY_URL = "socks5://127.0.0.1:7897"
#   $env:PI_WEB_CMD = "npm run start"   # full command override (legacy)
#   $env:PI_WEB_AUTH_BYPASS_CIDRS = "100.64.0.0/10"  # overrides policy file when set

[CmdletBinding()]
param(
  # Enable global access authentication and non-loopback-friendly bind (default 0.0.0.0).
  [switch]$Server,

  # Run next dev via the official launcher instead of production start.
  [switch]$Dev,

  # Do not open a browser when Ready (default for -Server).
  [switch]$NoOpen,

  # Force open browser on Ready even in server mode.
  [switch]$Open,

  # Rotate access key on boot (requires -Server).
  [switch]$RotateAccessKey,

  # Explicit compatibility escape hatch for HTTP access-key login.
  [switch]$AllowInsecureHttp,

  [string]$Port,
  [Alias("H")]
  [string]$Hostname,

  # One-shot env override for trusted client CIDRs (prefer server-access-policy.json).
  [string]$AuthBypassCidrs,

  # Upstream HTTP(S) proxy used by Node/fetch (not the Snail Pi listen address).
  [string]$ProxyUrl,
  [string]$SocksProxyUrl,

  # Extra args forwarded to bin/pi-web.js (e.g. --proxy http://...).
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$LauncherArgs
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Launcher = Join-Path $RepoRoot "bin\pi-web.js"
if (-not (Test-Path -LiteralPath $Launcher)) {
  throw "Launcher not found: $Launcher"
}

$PROXY_URL = if ($ProxyUrl) { $ProxyUrl } elseif ($env:PROXY_URL) { $env:PROXY_URL } else { "http://127.0.0.1:20112" }
$SOCKS_PROXY_URL = if ($SocksProxyUrl) { $SocksProxyUrl } elseif ($env:SOCKS_PROXY_URL) { $env:SOCKS_PROXY_URL } else { "socks5://127.0.0.1:20112" }

# curl/git/etc. often read these.
$env:http_proxy = $PROXY_URL
$env:https_proxy = $PROXY_URL
$env:all_proxy = $SOCKS_PROXY_URL
$env:HTTP_PROXY = $PROXY_URL
$env:HTTPS_PROXY = $PROXY_URL
$env:ALL_PROXY = $SOCKS_PROXY_URL

# Node 24+/26+ fetch/undici does not necessarily honor *_proxy by default.
if ($env:NODE_OPTIONS -notmatch '(^|\s)--use-env-proxy(\s|$)') {
  $env:NODE_OPTIONS = ("{0} --use-env-proxy" -f $env:NODE_OPTIONS).Trim()
}

if ($AuthBypassCidrs) {
  $env:PI_WEB_AUTH_BYPASS_CIDRS = $AuthBypassCidrs
}

# Build launcher argv unless the legacy PI_WEB_CMD full override is set.
$useLegacyCmd = [string]::IsNullOrWhiteSpace($env:PI_WEB_CMD) -eq $false
$argList = New-Object System.Collections.Generic.List[string]

if (-not $useLegacyCmd) {
  if ($Dev) { [void]$argList.Add("--dev") }
  if ($Server) { [void]$argList.Add("--server") }
  if ($RotateAccessKey) { [void]$argList.Add("--rotate-access-key") }
  if ($AllowInsecureHttp) { [void]$argList.Add("--allow-insecure-http") }
  if ($NoOpen) {
    [void]$argList.Add("--no-open")
  } elseif ($Server -and -not $Open) {
    # Server mode defaults to not auto-opening a remote/local browser.
    [void]$argList.Add("--no-open")
  }
  if ($Open) { [void]$argList.Add("--open") }
  if ($Port) {
    [void]$argList.Add("--port")
    [void]$argList.Add($Port)
  }
  if ($Hostname) {
    [void]$argList.Add("--hostname")
    [void]$argList.Add($Hostname)
  }
  if ($LauncherArgs) {
    foreach ($a in $LauncherArgs) {
      if ($null -ne $a -and "$a".Length -gt 0) { [void]$argList.Add("$a") }
    }
  }
}

$displayCmd = if ($useLegacyCmd) {
  $env:PI_WEB_CMD
} else {
  "node bin/pi-web.js $($argList -join ' ')"
}

Write-Host @"
== Snail Pi Web proxy startup ==
Repo: $RepoRoot
HTTP_PROXY=$env:HTTP_PROXY
HTTPS_PROXY=$env:HTTPS_PROXY
ALL_PROXY=$env:ALL_PROXY
NODE_OPTIONS=$env:NODE_OPTIONS
PI_WEB_SERVER_MODE=$(if ($Server) { '1 (via -Server)' } else { $env:PI_WEB_SERVER_MODE })
PI_WEB_AUTH_BYPASS_CIDRS=$($env:PI_WEB_AUTH_BYPASS_CIDRS)
Command: $displayCmd
"@

if ($Server) {
  Write-Host "Tip: durable Tailscale/local bypass -> %USERPROFILE%\.pi\agent\server-access-policy.json" -ForegroundColor DarkGray
  Write-Host '     { "version": 1, "authBypassCidrs": ["100.64.0.0/10"] }' -ForegroundColor DarkGray
}

Set-Location -LiteralPath $RepoRoot

if ($useLegacyCmd) {
  # Legacy escape hatch for fully custom commands.
  Invoke-Expression $env:PI_WEB_CMD
  exit $LASTEXITCODE
}

# Prefer direct node launch (no shell concatenation).
$node = Get-Command node -ErrorAction Stop
$processArgs = @($Launcher) + $argList
$p = Start-Process -FilePath $node.Source -ArgumentList $processArgs -WorkingDirectory $RepoRoot -NoNewWindow -Wait -PassThru
exit $p.ExitCode
