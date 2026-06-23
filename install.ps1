<#
  alsegno - installer for Windows (PowerShell 5.1+).
  Takes a fresh download (or clone) to a running app with a first admin login.

    powershell -ExecutionPolicy Bypass -File .\install.ps1            # interactive
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Yes       # accept defaults
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoService # set up only, no service
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Launch    # set up, then start the app

  -Launch is what start-windows.cmd uses: after setup it opens the app in your browser, and
  (unless you installed a boot service) runs the app in this window — close it to stop.

  Safe to re-run: an existing .env is never overwritten, and the service step backs off
  if the port is already in use.

  Prefer containers? See INSTALL.md "Option B: Run with Docker" for a docker compose setup instead.
#>
[CmdletBinding()]
param(
  [switch]$NoService,
  [switch]$Yes,
  [switch]$Launch
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoDir
$ServiceName    = 'alsegno'
$ServiceStarted = $false
$ServiceInstalledButStopped = $false   # a boot service was installed but failed to start

function Info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "  ok  $m" -ForegroundColor Green }
function Warn($m){ Write-Host "warn  $m" -ForegroundColor Yellow }
function Die($m) {
  Write-Host "error $m" -ForegroundColor Red
  # When double-clicked via start-windows.cmd the window would otherwise vanish before the
  # error can be read, so hold it open until the user acknowledges.
  if($Launch){ Write-Host ""; Read-Host "Setup stopped. Press Enter to close" | Out-Null }
  exit 1
}
function Have($c){ [bool](Get-Command $c -ErrorAction SilentlyContinue) }

function AskYN($q,$def){
  if($Yes){ return ($def -eq 'Y') }
  $hint = if($def -eq 'Y'){ '[Y/n]' } else { '[y/N]' }
  $a = Read-Host "$q $hint"
  if([string]::IsNullOrWhiteSpace($a)){ $a = $def }
  return ($a -match '^[Yy]')
}
function AskVal($q,$def){
  if($Yes){ return $def }
  $a = Read-Host "$q [$def]"
  if([string]::IsNullOrWhiteSpace($a)){ return $def } else { return $a }
}
function ReachLabel($share,$port){
  switch($share){
    'lan'        { "your local network - http://<this-computer-ip>:$port" }
    'cloudflare' { "a public Cloudflare link (a fresh one each time you start)" }
    'tailscale'  { "a public Tailscale Funnel link" }
    default      { "this computer only - http://localhost:$port" }
  }
}
# AskReach: returns @{ Share=...; HostAddr=... } from a menu (defaults to local under -Yes).
function AskReach($port){
  if($Yes){ return @{ Share='local'; HostAddr='127.0.0.1' } }
  Write-Host ""
  Write-Host "How should people reach alsegno?" -ForegroundColor White
  Write-Host ""
  Write-Host "  1) This computer only  (default - most private)"
  Write-Host "     Just this machine, at http://localhost:$port. Choose this if alsegno is only for"
  Write-Host "     you, or if you'll put your own reverse proxy / HTTPS in front of it."
  Write-Host ""
  Write-Host "  2) Your local network (Wi-Fi/LAN)"
  Write-Host "     Other devices on your network reach http://<this-computer-ip>:$port - handy to review"
  Write-Host "     from your phone at home. Plain HTTP (no HTTPS); use only on a network you trust."
  Write-Host ""
  Write-Host "  3) A shareable internet link - Cloudflare  (no router setup, no account)"
  Write-Host "     Downloads Cloudflare's free 'cloudflared' (~35 MB, official) and gives you a public"
  Write-Host "     https://...trycloudflare.com link when you start. Simplest way to send someone a link."
  Write-Host "     The link is a new one each time you start the app."
  Write-Host ""
  Write-Host "  4) A shareable internet link - Tailscale  (stable link, needs a free account)"
  Write-Host "     A permanent https://...ts.net link. You install Tailscale, sign in, and turn on Funnel"
  Write-Host "     once; the link then stays the same. Whoever you send it to needs nothing installed."
  Write-Host ""
  switch(AskVal 'Choose 1-4' '1'){
    '2'     { Warn "Local-network mode has no HTTPS - only use it on a network you trust."; return @{ Share='lan'; HostAddr='0.0.0.0' } }
    '3'     { return @{ Share='cloudflare'; HostAddr='127.0.0.1' } }
    '4'     { return @{ Share='tailscale';  HostAddr='127.0.0.1' } }
    default { return @{ Share='local';      HostAddr='127.0.0.1' } }
  }
}
function PortInUse($h,$p){
  # Probe the address the server actually binds. A 0.0.0.0 (or ::) listener accepts on loopback,
  # so map those to 127.0.0.1; otherwise probe the specific host so a LAN-IP bind is detected too.
  $t = if($h -eq '0.0.0.0' -or $h -eq '::'){ '127.0.0.1' } else { $h }
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect($t,[int]$p); $c.Close(); return $true }
  catch { return $false }
}

Write-Host ""
Write-Host "alsegno - setup (Windows)" -ForegroundColor White
Write-Host ""

# ── 1. Node.js >= 18 ─────────────────────────────────────────
Info "Checking Node.js..."
if(-not (Have node)){
  Die "Node.js not found. Install Node >= 18:`n  winget install OpenJS.NodeJS.LTS`n  or download from https://nodejs.org/"
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if($nodeMajor -lt 18){ Die "Node.js >= 18 required (found $(node -v)). Upgrade and re-run." }
if(-not (Have npm)){ Die "npm not found (it ships with Node.js). Reinstall Node." }
Ok "Node $(node -v)"

# ── 2. ffmpeg + ffprobe ──────────────────────────────────────
Info "Checking ffmpeg & ffprobe..."
if((Have ffmpeg) -and (Have ffprobe)){
  Ok "ffmpeg present"
} else {
  Warn "ffmpeg/ffprobe are NOT on PATH. Setup will finish, but every upload fails until you install them:"
  Write-Host "  winget install Gyan.FFmpeg"
  Write-Host "  or:  choco install ffmpeg"
  Write-Host "  (then open a NEW terminal so PATH refreshes)"
  if(-not (AskYN "Continue setup without ffmpeg?" 'Y')){ Die "Install ffmpeg + ffprobe, then re-run." }
}

# ── 3. dependencies ──────────────────────────────────────────
Info "Installing dependencies (npm ci)..."
# Prefer npm ci (exact, reproducible from the lockfile); fall back to npm install if it's unavailable.
npm ci --no-audit --no-fund
if($LASTEXITCODE -ne 0){
  Warn "npm ci unavailable (no/old lockfile?) - falling back to npm install..."
  npm install --no-audit --no-fund
}
if($LASTEXITCODE -ne 0){
  Warn "Dependency install failed - better-sqlite3 compiles a native module and may need build tools:"
  Write-Host "  Install 'Desktop development with C++' (Visual Studio Build Tools) and Python 3,"
  Write-Host "  or:  npm install --global node-gyp"
  Die "Install the build prerequisites above, then re-run."
}
Ok "Dependencies installed"

# ── 4. data directories ──────────────────────────────────────
Info "Creating data directories..."
New-Item -ItemType Directory -Force -Path (Join-Path $RepoDir 'data'),(Join-Path $RepoDir 'uploads') | Out-Null
Ok "data\ and uploads\ ready"

# ── 5. .env ──────────────────────────────────────────────────
$EnvFile = Join-Path $RepoDir '.env'
if(Test-Path $EnvFile){
  Ok ".env already exists - leaving it untouched"
} else {
  Info "Generating .env..."
  Write-Host "I'll ask three quick things. After the last one you'll get a summary and can redo them all."
  # Default the owner-admin to the current Windows account, not a hardcoded name.
  $defaultAdmin = if([string]::IsNullOrWhiteSpace($env:USERNAME)){ 'admin' } else { $env:USERNAME }
  $portVal = ''; $adminVal = ''; $shareVal = 'local'; $hostVal = '127.0.0.1'
  # Loop so a typo is fixable: answer "no" at the summary to go back and re-enter everything.
  while($true){
    # ── Port ──
    Write-Host ""
    Write-Host "Port - the number in the web address, e.g. http://localhost:3458."
    Write-Host "Keep the default unless 3458 is already used by another program."
    $portVal = AskVal 'Port' '3458'
    # ^\d{1,5}$ caps the value at 99999 so the [int] casts can never overflow Int32; -gt 65535 still rejects 65536-99999.
    if($portVal -notmatch '^\d{1,5}$' -or [int]$portVal -lt 1 -or [int]$portVal -gt 65535){
      Warn "Port must be a number 1-65535 - let's try again."; continue
    }
    # ── Admin username ──
    Write-Host ""
    Write-Host "Admin username - a NAME for the owner account (e.g. '$defaultAdmin'). This is NOT a password."
    Write-Host "You'll choose the password later, the first time you log in. Lowercase, no spaces."
    $adminVal = AskVal 'Admin username' $defaultAdmin
    # ── How people reach it ──
    $reach = AskReach $portVal
    $shareVal = $reach.Share; $hostVal = $reach.HostAddr
    # ── Review & confirm (answer "no" to go back and redo all three) ──
    Write-Host ""
    Write-Host "Please check these:" -ForegroundColor White
    Write-Host "  Port:           $portVal"
    Write-Host "  Admin username: $adminVal  (you'll set its password on first login)"
    Write-Host "  Reachable via:  $(ReachLabel $shareVal $portVal)"
    Write-Host ""
    if(AskYN "Is this correct?" 'Y'){ break }
    Write-Host ""
    Info "No problem - let's go through them again."
  }
  $secret = node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))"
  @(
    "PORT=$portVal","HOST=$hostVal","SESSION_SECRET=$secret","ADMIN_USER=$adminVal","SHARE=$shareVal",
    "",
    "# HTTPS lock-in (optional). Leave this OFF unless you know you want it.",
    "# If ON (ENABLE_HSTS=1) AND you open the site over a secure https link, browsers will",
    "# remember to only ever use the secure (https) version of your site. Good for security,",
    "# but browsers remember it for a long time - so if you later open the site over plain",
    "# http (no padlock) it may refuse to load until that memory fades. Behind nginx/Caddy",
    "# with https, leave this OFF and let the proxy handle it.",
    "# ENABLE_HSTS=0"
  ) -join "`r`n" | Set-Content -Path $EnvFile -Encoding ascii
  # Mirror the chmod 600 the sh installer applies: the file holds SESSION_SECRET, so strip inherited
  # ACEs and grant only the current user — otherwise a repo cloned outside the user profile (e.g. C:\)
  # inherits a readable-by-all-users ACL and the cookie-signing secret leaks to other local accounts.
  try { icacls $EnvFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null }
  catch { Warn "Could not restrict .env permissions (continuing): $_" }
  Ok ".env written (random SESSION_SECRET; admin=$adminVal; reach=$shareVal; PORT=$portVal)"
}

function GetEnv($key){
  $line = Get-Content $EnvFile | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if($line){ return ($line -replace "^$key=",'') } else { return '' }
}
$PortVal  = GetEnv 'PORT';       if(-not $PortVal){ $PortVal = '3458' }
$HostVal  = GetEnv 'HOST';       if(-not $HostVal){ $HostVal = '127.0.0.1' }
$AdminVal = GetEnv 'ADMIN_USER'; if(-not $AdminVal){ $AdminVal = 'james' }
$ShareVal = GetEnv 'SHARE';      if(-not $ShareVal){ $ShareVal = 'local' }
$NodePath = (Get-Command node).Source
$ServerJs = Join-Path $RepoDir 'server.js'

# ── 6. background service (boot start) ───────────────────────
if($NoService){
  Info "Skipping service install (-NoService)."
  Write-Host "  Start it with:  npm start"
} elseif(PortInUse $HostVal $PortVal){
  Warn "Port $PortVal is already in use - an instance may already be running. Skipping service install."
} elseif($ShareVal -eq 'cloudflare' -or $ShareVal -eq 'tailscale'){
  # A boot service runs only `node server.js` - it never recreates the tunnel/link. Offering
  # "start on boot" here would mislead a share-mode user into thinking their link stays live.
  Info "You chose a shareable link, which runs from this launcher window - skipping the boot-service step."
  Write-Host "  (A boot service would start alsegno locally on boot, but would NOT recreate your public link.)"
} elseif(AskYN "Install a Windows service so the app starts on boot?" 'Y'){
  if(Have nssm){
    # Note: $ErrorActionPreference='Stop' does NOT abort on a native exe's non-zero exit, so each
    # nssm/pm2 call's $LASTEXITCODE must be checked by hand — otherwise a failed start is reported
    # as success and the final "app not running" safety net is wrongly suppressed.
    Info "Installing Windows service '$ServiceName' via NSSM..."
    $installedOk = $true
    if(Get-Service -Name $ServiceName -ErrorAction SilentlyContinue){
      Info "Service '$ServiceName' already exists - reconfiguring it."
    } else {
      nssm install $ServiceName $NodePath $ServerJs | Out-Null
      if($LASTEXITCODE -ne 0){ Warn "nssm install failed (exit $LASTEXITCODE) - skipping service."; $installedOk = $false }
    }
    if($installedOk){
      nssm set $ServiceName AppDirectory $RepoDir | Out-Null
      nssm set $ServiceName AppStdout (Join-Path $RepoDir 'data\alsegno.log') | Out-Null
      nssm set $ServiceName AppStderr (Join-Path $RepoDir 'data\alsegno.err.log') | Out-Null
      nssm start $ServiceName | Out-Null
      if($LASTEXITCODE -eq 0){
        $ServiceStarted = $true
        Ok "Service '$ServiceName' installed and started (NSSM)."
        Write-Host "  Manage:  nssm {stop|start|restart|remove} $ServiceName"
      } else {
        $ServiceInstalledButStopped = $true
        Warn "Service '$ServiceName' is installed but did not start (exit $LASTEXITCODE). Check data\alsegno.err.log, then run: nssm start $ServiceName"
      }
    }
  } elseif(Have pm2){
    Info "NSSM not found; starting under pm2 instead..."
    pm2 start $ServerJs --name 'alsegno'
    if($LASTEXITCODE -eq 0){
      pm2 save | Out-Null
      $ServiceStarted = $true
      Ok "Started under pm2."
      Write-Host "  Enable boot start with: pm2 startup (see pm2 docs on Windows)"
    } else {
      Warn "pm2 failed to start the app (exit $LASTEXITCODE). Run 'pm2 logs alsegno' to see why."
    }
  } else {
    Warn "NSSM not found. Install it for a boot service:  winget install NSSM.NSSM   (or choco install nssm)"
    Write-Host "  Then re-run this script, or just start manually with:  npm start"
  }
}

# ── done ─────────────────────────────────────────────────────
$urlHost = if($HostVal -eq '0.0.0.0'){ 'localhost' } else { $HostVal }
$url = "http://${urlHost}:$PortVal"
Write-Host ""
Ok "Setup complete."
Write-Host "  Open:  $url"
if($HostVal -eq '0.0.0.0'){ Write-Host "         (or http://<this-machine-ip>:$PortVal from another device on your network)" }
Write-Host "  Log in as '$AdminVal' - the password you type on its FIRST login becomes the account password."

# ── shareable-link helpers (SHARE=cloudflare / tailscale) ────
$script:AppProc = $null
$script:CfProc  = $null
$script:CfBin   = ''
$script:ShareOk = $false
# Start the app in the background if nothing already serves the port. -NoNewWindow keeps node
# attached to THIS console, so closing the window (CTRL_CLOSE) stops it too.
function Ensure-AppRunning {
  if(PortInUse $HostVal $PortVal){ return $true }
  Ok "Starting alsegno..."
  $log = Join-Path $RepoDir 'data\alsegno.log'; $errlog = Join-Path $RepoDir 'data\alsegno.err.log'
  $script:AppProc = Start-Process -FilePath $NodePath -ArgumentList $ServerJs -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $errlog
  for($i=0; $i -lt 150 -and -not (PortInUse $HostVal $PortVal); $i++){ Start-Sleep -Milliseconds 200 }
  if(PortInUse $HostVal $PortVal){ return $true }
  Warn "alsegno didn't start (see data\alsegno.err.log)."; return $false
}
# Download Cloudflare's cloudflared into .\bin if it isn't already available; sets $script:CfBin.
# Is the file a runnable cloudflared? (guards against a truncated download being cached + re-run forever)
function Test-CfBinary($p){
  if(-not (Test-Path $p)){ return $false }
  try { & $p --version *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}
function Ensure-Cloudflared {
  $c = Get-Command cloudflared -ErrorAction SilentlyContinue
  if($c){ $script:CfBin = $c.Source; return $true }
  $bindir = Join-Path $RepoDir 'bin'; $script:CfBin = Join-Path $bindir 'cloudflared.exe'
  if(Test-CfBinary $script:CfBin){ return $true }                                   # cached + runnable
  Remove-Item $script:CfBin -Force -ErrorAction SilentlyContinue                    # truncated cache -> re-fetch
  New-Item -ItemType Directory -Force -Path $bindir | Out-Null
  $arch = if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){ 'arm64' } elseif([Environment]::Is64BitOperatingSystem){ 'amd64' } else { '386' }
  $dl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"
  Info "Downloading Cloudflare cloudflared (~35 MB, official)..."
  try { $op = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri $dl -OutFile $script:CfBin -UseBasicParsing; $ProgressPreference = $op }
  catch { Warn "Download failed: $_"; return $false }
  if(Test-CfBinary $script:CfBin){ return $true }
  Warn "The downloaded cloudflared isn't runnable (incomplete download?). Removing it - try again."
  Remove-Item $script:CfBin -Force -ErrorAction SilentlyContinue
  return $false
}
# ── LAN / port-forward sharing (used when a tunnel can't be created) ──
function Get-ExtIp { try { (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 5 -ErrorAction Stop).ToString().Trim() } catch { '' } }
function Get-LanIp {
  try {
    $a = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
         Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1
    if($a){ return $a.IPAddress }
  } catch {}
  return ''
}
function Set-EnvKv($k,$v){
  if(-not (Test-Path $EnvFile)){ return }
  $lines = @(Get-Content $EnvFile)
  if($lines -match "^$k="){ $lines = $lines | ForEach-Object { if($_ -match "^$k="){ "$k=$v" } else { $_ } } }
  else { $lines += "$k=$v" }
  ($lines -join "`r`n") | Set-Content -Path $EnvFile -Encoding ascii
}
function Show-ShareLan($persisted){
  $lan = Get-LanIp; $ext = Get-ExtIp
  Write-Host ""
  Write-Host "To share alsegno without a tunnel:" -ForegroundColor White
  if($lan){ Write-Host "  - Same Wi-Fi / network:  http://${lan}:$PortVal  (no setup needed)" }
  if($ext){ Write-Host "  - Over the internet:     http://${ext}:$PortVal" } else { Write-Host "  - Over the internet:     http://<your-public-IP>:$PortVal" }
  Write-Host "       -> first forward port $PortVal on your router to this computer, then send that link."
  Warn "  Internet sharing this way is plain HTTP (no HTTPS) and needs router port-forwarding"
  Warn "  (it won't work behind carrier-grade NAT). alsegno's login still gates access - share only with people you trust."
  if($persisted){ Write-Host "  Future launches use this local-network mode - set SHARE=cloudflare or SHARE=tailscale in .env to try a tunnel again." }
}
# Rebind to the LAN (0.0.0.0) and run the app HERE with port-forward info. $true persists SHARE=lan.
function Run-LanShare($persist){
  if($script:AppProc -and -not $script:AppProc.HasExited){
    Stop-Process -Id $script:AppProc.Id -Force -ErrorAction SilentlyContinue
    for($i=0; $i -lt 50 -and (PortInUse '127.0.0.1' $PortVal); $i++){ Start-Sleep -Milliseconds 100 }   # wait for the loopback bind to release
  }
  $script:AppProc = $null
  if($persist){ Set-EnvKv 'HOST' '0.0.0.0'; Set-EnvKv 'SHARE' 'lan' }
  Show-ShareLan $persist
  if(PortInUse '0.0.0.0' $PortVal){
    Write-Host ""; Ok "alsegno is already running. Opening http://localhost:$PortVal ..."; try { Start-Process "http://localhost:$PortVal" } catch {}
    $script:ShareOk = $true; return
  }
  Write-Host ""
  Ok "Starting alsegno. Keep this window open while you use it; close it (or press Ctrl+C) to stop."
  Start-Job -ScriptBlock { param($p) for($i=0; $i -lt 150; $i++){ try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',[int]$p); $c.Close(); break } catch { Start-Sleep -Milliseconds 200 } }; try { Start-Process "http://localhost:$p" } catch {} } -ArgumentList $PortVal | Out-Null
  Write-Host ""
  $env:HOST = '0.0.0.0'        # bind to the LAN for this run (dotenv won't override an existing env var)
  & $NodePath $ServerJs
  Remove-Item Env:\HOST -ErrorAction SilentlyContinue
  if($LASTEXITCODE -ne 0){
    Write-Host ""; Warn "alsegno stopped unexpectedly (exit $LASTEXITCODE). The error is shown above."
    Read-Host "Press Enter to close" | Out-Null
  }
  $script:ShareOk = $true
}
# Run app + a Cloudflare quick tunnel and print the public link. Sets $script:ShareOk on success.
function Launch-WithCloudflare {
  if(-not (Ensure-Cloudflared)){ Warn "Couldn't download/run cloudflared - using local-network sharing instead."; Run-LanShare $true; return }
  if(-not (Ensure-AppRunning)){ return }
  Write-Host ""
  Ok "Creating your public link..."
  $cflog = Join-Path $env:TEMP ("alsegno-cf-" + [Guid]::NewGuid().ToString('N') + ".log")
  $script:CfProc = Start-Process -FilePath $script:CfBin -ArgumentList @('tunnel','--url',"http://127.0.0.1:$PortVal",'--no-autoupdate') -NoNewWindow -PassThru -RedirectStandardOutput $cflog -RedirectStandardError "$cflog.err"
  $link = ''
  for($i=0; $i -lt 150; $i++){
    foreach($f in @($cflog, "$cflog.err")){
      if(Test-Path $f){
        $m = Select-String -Path $f -Pattern 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1   # multi-word host only: never match api.trycloudflare.com (logged on failure)
        if($m){ $link = $m.Matches[0].Value; break }
      }
    }
    if($link){ break }
    if($script:CfProc.HasExited){ break }
    Start-Sleep -Milliseconds 300
  }
  Write-Host ""
  if($link){
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host "  Send this link to anyone you want to review:"
    Write-Host ""
    Write-Host "      $link" -ForegroundColor Green
    Write-Host ""
    Write-Host "  (On this computer: http://localhost:$PortVal)"
    Write-Host "========================================================" -ForegroundColor Green
    try { Start-Process $link } catch {}
  } else {
    Warn "Couldn't create the public Cloudflare link. cloudflared reported:"
    if(Test-Path "$cflog.err"){ Get-Content "$cflog.err" -Tail 8 }
    elseif(Test-Path $cflog){ Get-Content $cflog -Tail 8 }
    Write-Host "  (Usually a network/firewall blocking the tunnel, or Cloudflare being busy.)"
    if($script:CfProc -and -not $script:CfProc.HasExited){ Stop-Process -Id $script:CfProc.Id -Force -ErrorAction SilentlyContinue }
    Run-LanShare $true   # rebind to the LAN, remember it (don't retry the failing tunnel next time)
    return
  }
  Write-Host ""
  Write-Host "Keep this window open while you share. Close it (or press Ctrl+C) to stop alsegno and the link."
  try { Wait-Process -Id $script:CfProc.Id -ErrorAction SilentlyContinue } catch {}
  $script:ShareOk = $true
}
# Publish over Tailscale Funnel (stable link). Sets $script:ShareOk on success.
function Launch-WithTailscale {
  if(-not (Get-Command tailscale -ErrorAction SilentlyContinue)){
    Warn "Tailscale isn't installed. For a stable Tailscale link later: install it"
    Write-Host "  (https://tailscale.com/download), run 'tailscale up', then re-run this. For now, sharing locally:"
    Run-LanShare $false; return
  }
  & tailscale status *> $null
  if($LASTEXITCODE -ne 0){
    Warn "Tailscale is installed but you're not signed in. Run 'tailscale up', then re-run this. For now, sharing locally:"
    Run-LanShare $false; return
  }
  if(-not (Ensure-AppRunning)){ return }
  Write-Host ""
  Ok "Publishing alsegno over Tailscale Funnel..."
  Write-Host "  If Tailscale asks you to turn on Funnel, follow the link it prints, then it'll show your URL."
  Write-Host "  Keep this window open while you share; press Ctrl+C to stop."
  & tailscale funnel $PortVal
  $script:ShareOk = $true
}

if($Launch){
  if($ShareVal -eq 'cloudflare' -or $ShareVal -eq 'tailscale'){
    try {
      if($ShareVal -eq 'cloudflare'){ Launch-WithCloudflare } else { Launch-WithTailscale }
    } finally {
      if($script:CfProc  -and -not $script:CfProc.HasExited){  Stop-Process -Id $script:CfProc.Id  -Force -ErrorAction SilentlyContinue }
      if($script:AppProc -and -not $script:AppProc.HasExited){ Stop-Process -Id $script:AppProc.Id -Force -ErrorAction SilentlyContinue }
    }
    # If a share mode was chosen but couldn't be set up, say so before falling through to a local run.
    if(-not $script:ShareOk){
      Write-Host ""
      Warn "Couldn't set up the public link - starting alsegno locally instead (reachable only on this computer)."
      Write-Host "  Re-run this when you're back online to try the link again, or change SHARE in .env."
    }
  } elseif($ShareVal -eq 'lan'){
    Run-LanShare $false
  }
  if($script:ShareOk){
    # the share helper already ran alsegno + the tunnel; nothing more to do
  } elseif($ServiceInstalledButStopped){
    # A boot service is installed but didn't start. Do NOT run a foreground copy - it would fight
    # the service for the port the next time the service (auto)starts. Help the user recover instead.
    Write-Host ""
    Warn "A background service 'alsegno' is installed but isn't running."
    Warn "Fix the cause (see data\alsegno.err.log), then run:  nssm start $ServiceName"
    Write-Host ""
    Read-Host "Press Enter to close" | Out-Null
  } elseif($ServiceStarted){
    # We started a boot service. Wait until it's actually listening, THEN open the browser - the
    # service-control call returns before node has bound the port, so opening immediately races it.
    Write-Host ""
    Ok "alsegno is starting as a background service..."
    for($i=0; $i -lt 150 -and -not (PortInUse $HostVal $PortVal); $i++){ Start-Sleep -Milliseconds 200 }
    Ok "Opening $url ..."
    try { Start-Process $url } catch {}
  } elseif(PortInUse $HostVal $PortVal){
    # Something already holds the port and we didn't start it: maybe an alsegno instance you already
    # have open, maybe another program. Don't claim success, and don't risk an EADDRINUSE crash.
    Write-Host ""
    Warn "Port $PortVal is already in use."
    Write-Host "  If alsegno is already running, it's at $url (opening it now)."
    Write-Host "  If another program uses that port, set a different PORT in .env and run this again."
    try { Start-Process $url } catch {}
    Write-Host ""
    Read-Host "Press Enter to close" | Out-Null
  } else {
    # No background service: run the app in THIS window. The window IS the running app.
    Write-Host ""
    Ok "Starting alsegno. Keep this window open while you use it; close it (or press Ctrl+C) to stop."
    # Open the browser once the server is accepting connections, without blocking the server.
    Start-Job -ScriptBlock {
      param($u,$p)
      for($i=0; $i -lt 150; $i++){
        try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',[int]$p); $c.Close(); break }
        catch { Start-Sleep -Milliseconds 200 }
      }
      try { Start-Process $u } catch {}
    } -ArgumentList $url,$PortVal | Out-Null
    Write-Host ""
    # Run node directly (not 'npm start') so there's no npm.cmd batch wrapper: Ctrl+C stops cleanly
    # with no "Terminate batch job (Y/N)?" prompt, and we get node's real exit code below.
    & $NodePath $ServerJs
    if($LASTEXITCODE -ne 0){
      # node exited on its own - a crash (e.g. a port grabbed after our check, or a broken native
      # module). A user Ctrl+C / window-close does NOT reach here, so this only fires on real failure.
      Write-Host ""
      Warn "alsegno stopped unexpectedly (exit $LASTEXITCODE). The error is shown above."
      Write-Host "  If the port is already in use, an instance or service may already be running."
      Read-Host "Press Enter to close" | Out-Null
    }
  }
} elseif(-not $ServiceStarted){
  # Ran as a plain installer (not via the launcher): tell the user how to start it themselves.
  Write-Host ""
  Warn "The app is not running yet - start it with 'npm start', then open the URL."
}
Write-Host ""
