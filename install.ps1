<#
  alsegno - installer for Windows (PowerShell 5.1+).
  Takes a fresh download (or clone) to a running app with a first admin login.

    powershell -ExecutionPolicy Bypass -File .\install.ps1            # interactive
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Yes       # accept defaults
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoService # set up only, no service

  Safe to re-run: an existing .env is never overwritten, and the service step backs off
  if the port is already in use.

  Prefer containers? See INSTALL.md "Option B: Run with Docker" for a docker compose setup instead.
#>
[CmdletBinding()]
param(
  [switch]$NoService,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoDir
$ServiceName    = 'alsegno'
$ServiceStarted = $false

function Info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "  ok  $m" -ForegroundColor Green }
function Warn($m){ Write-Host "warn  $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "error $m" -ForegroundColor Red; exit 1 }
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
Info "Installing dependencies (npm install)..."
npm install --no-audit --no-fund
if($LASTEXITCODE -ne 0){
  Warn "npm install failed - better-sqlite3 compiles a native module and may need build tools:"
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
  $portVal  = AskVal 'Port to listen on' '3458'
  # ^\d{1,5}$ caps the value at 99999 so the [int] casts below can never overflow Int32 (which
  # would throw an unhandled error under StrictMode/Stop); -gt 65535 still rejects 65536-99999.
  if($portVal -notmatch '^\d{1,5}$' -or [int]$portVal -lt 1 -or [int]$portVal -gt 65535){
    Die "Port must be a number 1-65535 (got '$portVal')."
  }
  # Default the owner-admin to the current Windows account, not a hardcoded name.
  $defaultAdmin = if([string]::IsNullOrWhiteSpace($env:USERNAME)){ 'admin' } else { $env:USERNAME }
  $adminVal = AskVal 'Admin username (its FIRST login sets the password)' $defaultAdmin
  $hostVal  = '127.0.0.1'
  if(AskYN "Make the app reachable from other devices on your network (LAN)?" 'N'){
    $hostVal = '0.0.0.0'
    Warn "Binding to 0.0.0.0 - only on a network you trust (the bare port has no HTTPS)."
  }
  $secret = node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))"
  @("PORT=$portVal","HOST=$hostVal","SESSION_SECRET=$secret","ADMIN_USER=$adminVal") `
    -join "`r`n" | Set-Content -Path $EnvFile -Encoding ascii
  # Mirror the chmod 600 the sh installer applies: the file holds SESSION_SECRET, so strip inherited
  # ACEs and grant only the current user — otherwise a repo cloned outside the user profile (e.g. C:\)
  # inherits a readable-by-all-users ACL and the cookie-signing secret leaks to other local accounts.
  try { icacls $EnvFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null }
  catch { Warn "Could not restrict .env permissions (continuing): $_" }
  Ok ".env written (random SESSION_SECRET; admin=$adminVal; HOST=$hostVal; PORT=$portVal)"
}

function GetEnv($key){
  $line = Get-Content $EnvFile | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if($line){ return ($line -replace "^$key=",'') } else { return '' }
}
$PortVal  = GetEnv 'PORT';       if(-not $PortVal){ $PortVal = '3458' }
$HostVal  = GetEnv 'HOST';       if(-not $HostVal){ $HostVal = '127.0.0.1' }
$AdminVal = GetEnv 'ADMIN_USER'; if(-not $AdminVal){ $AdminVal = 'james' }
$NodePath = (Get-Command node).Source
$ServerJs = Join-Path $RepoDir 'server.js'

# ── 6. background service (boot start) ───────────────────────
if($NoService){
  Info "Skipping service install (-NoService)."
  Write-Host "  Start it with:  npm start"
} elseif(PortInUse $HostVal $PortVal){
  Warn "Port $PortVal is already in use - an instance may already be running. Skipping service install."
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
Write-Host ""
Ok "Setup complete."
Write-Host "  Open:  http://${urlHost}:$PortVal"
if($HostVal -eq '0.0.0.0'){ Write-Host "         (or http://<this-machine-ip>:$PortVal from another device on your network)" }
Write-Host "  Log in as '$AdminVal' - the password you type on its FIRST login becomes the account password."
if(-not $ServiceStarted){
  Write-Host ""
  Warn "The app is not running yet - start it with 'npm start', then open the URL."
}
Write-Host ""
