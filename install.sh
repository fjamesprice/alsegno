#!/usr/bin/env bash
#
# alsegno — installer for Linux & macOS.
# Takes a fresh download (or clone) to a running app with a first admin login.
#
#   ./install.sh              interactive: prompts for port / admin / LAN exposure / service
#   ./install.sh --yes        non-interactive: accept every default
#   ./install.sh --no-service set up only; don't install or start a background service
#   ./install.sh --launch     set up, then start the app + open the browser (start-macos.command uses this)
#
# Safe to re-run: an existing .env is never overwritten, and the service step backs off
# if the port is already in use (so it won't fight an instance you're already running).
#
# Prefer containers? See INSTALL.md "Option B: Run with Docker" for a `docker compose` setup instead.
#
set -euo pipefail

# ── args ─────────────────────────────────────────────────────
SKIP_SERVICE=0
ASSUME_YES=0
LAUNCH=0
usage() { sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; }
for arg in "$@"; do
  case "$arg" in
    --no-service) SKIP_SERVICE=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --launch)     LAUNCH=1 ;;
    -h|--help)    usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; usage; exit 1 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"
SERVICE_NAME="alsegno"
SERVICE_STARTED=0

# ── output helpers ───────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=''; RED=''; GRN=''; YLW=''; CYN=''; RST=''
fi
say()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$CYN" "$RST" "$*"; }
ok()   { printf '%s  ok%s  %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%swarn%s  %s\n' "$YLW" "$RST" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ask_yn "question" DEFAULT(Y|N) -> exit 0 = yes. Non-interactive / piped input uses the default.
ask_yn() {
  local q="$1" def="${2:-N}" ans hint
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then [ "$def" = Y ]; return; fi
  hint="[y/N]"; [ "$def" = Y ] && hint="[Y/n]"
  read -r -p "$q $hint " ans || ans=""
  ans="${ans:-$def}"
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}
# ask_val "prompt" DEFAULT -> echoes the answer (read prompt goes to stderr, so $(...) is clean).
ask_val() {
  local q="$1" def="$2" ans
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then printf '%s' "$def"; return; fi
  read -r -p "$q [$def] " ans || ans=""
  printf '%s' "${ans:-$def}"
}

# ── platform ─────────────────────────────────────────────────
case "$(uname -s)" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) die "Unsupported OS '$(uname -s)'. This installer is for Linux & macOS; use install.ps1 on Windows." ;;
esac

node_hint() {
  if [ "$PLATFORM" = macos ]; then
    say "  brew install node          # or download the >=18 LTS from https://nodejs.org/"
  else
    say "  Debian/Ubuntu:  see https://github.com/nodesource/distributions  (distro 'nodejs' is often too old)"
    say "  Fedora/RHEL:    sudo dnf install -y nodejs"
    say "  Arch:           sudo pacman -S nodejs npm"
    say "  or download the >=18 LTS from https://nodejs.org/"
  fi
}
ffmpeg_hint() {
  if [ "$PLATFORM" = macos ]; then
    say "  brew install ffmpeg"
  else
    say "  Debian/Ubuntu:  sudo apt-get install -y ffmpeg"
    say "  Fedora/RHEL:    sudo dnf install -y ffmpeg     # may need RPM Fusion"
    say "  Arch:           sudo pacman -S ffmpeg"
    say "  openSUSE:       sudo zypper install -y ffmpeg"
  fi
}
buildtools_hint() {
  if [ "$PLATFORM" = macos ]; then
    say "  xcode-select --install"
  else
    say "  Debian/Ubuntu:  sudo apt-get install -y build-essential python3"
    say "  Fedora/RHEL:    sudo dnf groupinstall -y 'Development Tools' && sudo dnf install -y python3"
  fi
}

say ""
say "${BOLD}alsegno — setup ($PLATFORM)${RST}"
say ""

# ── 1. Node.js >= 18 ─────────────────────────────────────────
info "Checking Node.js…"
have node || { node_hint; die "Node.js not found. Install Node >= 18 and re-run."; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "${NODE_MAJOR:-0}" -ge 18 ] || { node_hint; die "Node.js >= 18 required (found $(node -v)). Upgrade and re-run."; }
have npm || die "npm not found (it ships with Node.js). Reinstall Node."
ok "Node $(node -v)"

# ── 2. ffmpeg + ffprobe (hard runtime dep, but don't block setup) ────
info "Checking ffmpeg & ffprobe…"
if have ffmpeg && have ffprobe; then
  ff_line="$(ffmpeg -version 2>/dev/null | head -1 || true)"
  ok "${ff_line:-ffmpeg present}"
else
  warn "ffmpeg/ffprobe are NOT on PATH. Setup will finish, but every upload fails until you install them:"
  ffmpeg_hint
  ask_yn "Continue setup without ffmpeg?" Y || die "Install ffmpeg + ffprobe, then re-run."
fi

# ── 3. dependencies ──────────────────────────────────────────
info "Installing dependencies (npm install)…"
if ! npm install --no-audit --no-fund; then
  warn "npm install failed — better-sqlite3 compiles a native module and may need build tools:"
  buildtools_hint
  die "Install the build prerequisites above, then re-run."
fi
ok "Dependencies installed"

# ── 4. data directories ──────────────────────────────────────
info "Creating data directories…"
DATA_DIR_RESOLVED="${DATA_DIR:-$REPO_DIR/data}"
UPLOADS_DIR_RESOLVED="${UPLOADS_DIR:-$REPO_DIR/uploads}"
mkdir -p "$DATA_DIR_RESOLVED" "$UPLOADS_DIR_RESOLVED"
ok "data → $DATA_DIR_RESOLVED"
ok "uploads → $UPLOADS_DIR_RESOLVED"

# ── 5. .env ──────────────────────────────────────────────────
ENV_FILE="$REPO_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  ok ".env already exists — leaving it untouched"
else
  info "Generating .env…"
  port_val="$(ask_val 'Port to listen on' '3458')"
  case "$port_val" in
    ''|*[!0-9]*) die "Port must be a whole number 1–65535 (got '$port_val')." ;;
  esac
  { [ "$port_val" -ge 1 ] && [ "$port_val" -le 65535 ]; } || die "Port out of range 1–65535 (got '$port_val')."
  # Default the owner-admin to the account running the install (SUDO_USER if run via sudo), not a
  # hardcoded name — this is a tool other people install for themselves.
  default_admin="${SUDO_USER:-$(id -un)}"; [ -n "$default_admin" ] || default_admin="admin"
  admin_val="$(ask_val 'Admin username (its FIRST login sets the password)' "$default_admin")"
  host_val="127.0.0.1"
  if ask_yn "Make the app reachable from other devices on your network (LAN)?" N; then
    host_val="0.0.0.0"
    warn "Binding to 0.0.0.0 — only do this on a network you trust (the bare port has no HTTPS)."
  fi
  secret="$(node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("hex"))')"
  ( umask 077; cat > "$ENV_FILE" <<EOF
PORT=$port_val
HOST=$host_val
SESSION_SECRET=$secret
ADMIN_USER=$admin_val
EOF
  )
  # Persist DATA_DIR/UPLOADS_DIR only when overridden, so the booted service (which reads them via
  # dotenv from .env, NOT from the installer's shell env) stores data where setup actually prepared it.
  if [ "$DATA_DIR_RESOLVED" != "$REPO_DIR/data" ]; then printf 'DATA_DIR=%s\n' "$DATA_DIR_RESOLVED" >> "$ENV_FILE"; fi
  if [ "$UPLOADS_DIR_RESOLVED" != "$REPO_DIR/uploads" ]; then printf 'UPLOADS_DIR=%s\n' "$UPLOADS_DIR_RESOLVED" >> "$ENV_FILE"; fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  ok ".env written (random SESSION_SECRET; admin=$admin_val; HOST=$host_val; PORT=$port_val)"
fi

# read effective values back for the service + final message (simple KEY=VALUE lines)
get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }
PORT_VAL="$(get_env PORT)";       PORT_VAL="${PORT_VAL:-3458}"
HOST_VAL="$(get_env HOST)";       HOST_VAL="${HOST_VAL:-127.0.0.1}"
ADMIN_VAL="$(get_env ADMIN_USER)"; ADMIN_VAL="${ADMIN_VAL:-james}"
NODE_BIN="$(command -v node)"

# ── 6. background service (boot start) ───────────────────────
# port_in_use HOST PORT — true if something is already listening. A 0.0.0.0/:: listener also
# accepts on loopback, so probe 127.0.0.1 for those; otherwise probe the specific bind address.
port_in_use() {
  local probe="$1"
  if [ "$probe" = "0.0.0.0" ] || [ "$probe" = "::" ] || [ -z "$probe" ]; then probe="127.0.0.1"; fi
  node -e "const net=require('net');const s=net.connect({host:'$probe',port:$2},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000);" 2>/dev/null
}

install_systemd() {
  local user unit tmp SUDO=""
  user="${SUDO_USER:-$(id -un)}"
  unit="/etc/systemd/system/${SERVICE_NAME}.service"
  [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  info "Installing a systemd service '$SERVICE_NAME' (runs as '$user', needs root)…"
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
[Unit]
Description=alsegno (mix/master revision tracker)
After=network.target

[Service]
Type=simple
User=$user
WorkingDirectory=$REPO_DIR
ExecStart=$NODE_BIN $REPO_DIR/server.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  $SUDO cp "$tmp" "$unit"; rm -f "$tmp"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "${SERVICE_NAME}.service"
  SERVICE_STARTED=1
  ok "systemd service installed and started."
  say "  Manage:  sudo systemctl {status|restart|stop} $SERVICE_NAME"
  say "  Logs:    journalctl -u $SERVICE_NAME -f"
}

install_launchd() {
  local label plist
  label="com.alsegno.server"
  plist="$HOME/Library/LaunchAgents/${label}.plist"
  info "Installing a launchd agent '$label'…"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR_RESOLVED/alsegno.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR_RESOLVED/alsegno.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  SERVICE_STARTED=1
  ok "launchd agent installed and started."
  say "  Manage:  launchctl {unload|load} $plist"
}

install_pm2() {
  info "Starting under pm2…"
  pm2 start "$REPO_DIR/server.js" --name "$SERVICE_NAME"
  pm2 save || true
  SERVICE_STARTED=1
  ok "Started under pm2 as '$SERVICE_NAME'."
  say "  Enable boot start:  pm2 startup   (then run the command it prints)"
}

manual_hint() { say "  Start it with:  ${BOLD}cd $REPO_DIR && npm start${RST}"; }

if [ "$SKIP_SERVICE" = 1 ]; then
  info "Skipping service install (--no-service)."
  manual_hint
elif port_in_use "$HOST_VAL" "$PORT_VAL"; then
  warn "Port $PORT_VAL is already in use — an instance may already be running. Skipping service install."
  warn "Stop the existing instance first if you want this installer to manage it."
elif have pm2 && pm2 describe "$SERVICE_NAME" >/dev/null 2>&1; then
  warn "pm2 already manages '$SERVICE_NAME' — leaving it as-is (use 'pm2 restart $SERVICE_NAME' to apply changes)."
elif ask_yn "Install a background service so the app starts on boot?" Y; then
  if [ "$PLATFORM" = linux ]; then
    if have systemctl && [ -d /run/systemd/system ]; then install_systemd
    elif have pm2; then install_pm2
    else warn "No systemd or pm2 found — can't install a boot service automatically."; manual_hint; fi
  else
    if have launchctl; then install_launchd
    elif have pm2; then install_pm2
    else warn "launchctl not found — can't install a boot service."; manual_hint; fi
  fi
else
  manual_hint
fi

# ── done ─────────────────────────────────────────────────────
url_host="$HOST_VAL"; [ "$HOST_VAL" = "0.0.0.0" ] && url_host="localhost"
URL="http://$url_host:$PORT_VAL"
say ""
ok "${BOLD}Setup complete.${RST}"
say "  Open:  ${BOLD}$URL${RST}"
[ "$HOST_VAL" = "0.0.0.0" ] && say "         (or http://<this-machine-ip>:$PORT_VAL from another device on your network)"
say "  Log in as ${BOLD}$ADMIN_VAL${RST} — the password you type on its FIRST login becomes the account password."

# best-effort "open in browser" (no-op on a headless box, which is fine)
open_url() {
  if [ "$PLATFORM" = macos ] && have open; then ( open "$1" >/dev/null 2>&1 & )
  elif have xdg-open; then ( xdg-open "$1" >/dev/null 2>&1 & )
  fi
}

if [ "$LAUNCH" = 1 ]; then
  if [ "$SERVICE_STARTED" = 1 ]; then
    # We started a boot service. Wait until it's actually listening, THEN open the browser — the
    # service manager returns before the server has bound the port, so opening immediately races it.
    say ""
    ok "alsegno is starting as a background service…"
    for _ in $(seq 1 150); do
      if (exec 3<>"/dev/tcp/127.0.0.1/$PORT_VAL") 2>/dev/null; then exec 3>&- 3<&-; break; fi
      sleep 0.2
    done
    ok "Opening $URL …"
    open_url "$URL"
  elif port_in_use "$HOST_VAL" "$PORT_VAL"; then
    # Something already holds the port and we didn't start it: maybe an alsegno instance you already
    # have open, maybe another program. Don't claim success, and don't risk an address-in-use crash.
    say ""
    warn "Port $PORT_VAL is already in use."
    say "  If alsegno is already running, it's at $URL (opening it now)."
    say "  If another program uses that port, set a different PORT in .env and run this again."
    open_url "$URL"
  else
    # No background service: run the app in THIS window. The window IS the running app.
    say ""
    ok "${BOLD}Starting alsegno.${RST} Keep this window open while you use it; press Ctrl+C (or close it) to stop."
    # Open the browser once the server is accepting connections, without blocking 'npm start'.
    ( for _ in $(seq 1 150); do
        if (exec 3<>"/dev/tcp/127.0.0.1/$PORT_VAL") 2>/dev/null; then exec 3>&- 3<&-; open_url "$URL"; break; fi
        sleep 0.2
      done ) &
    say ""
    npm start               # blocks until the window is closed / Ctrl+C — the window IS the app
  fi
elif [ "$SERVICE_STARTED" != 1 ]; then
  # Ran as a plain installer (not via the launcher): tell the user how to start it themselves.
  say ""
  warn "The app is not running yet — start it (see above), then open the URL."
fi
say ""
