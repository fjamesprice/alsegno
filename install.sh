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

# reach_label SHARE PORT -> one-line human summary of the chosen reach method
reach_label() {
  case "$1" in
    lan)        printf 'your local network — http://<this-computer-ip>:%s' "$2" ;;
    cloudflare) printf 'a public Cloudflare link (a fresh one each time you start)' ;;
    tailscale)  printf 'a public Tailscale Funnel link' ;;
    *)          printf 'this computer only — http://localhost:%s' "$2" ;;
  esac
}

# ask_reach -> sets globals host_val + share_val from a menu (defaults to local when non-interactive)
ask_reach() {
  share_val="local"; host_val="127.0.0.1"
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then return; fi
  say ""
  say "${BOLD}How should people reach alsegno?${RST} (you can pick again at the summary if unsure)"
  say ""
  say "  ${BOLD}1) This computer only${RST}  (default — most private)"
  say "     Just this machine, at http://localhost:$port_val. Choose this if alsegno is only for"
  say "     you, or if you'll put your own reverse proxy / HTTPS in front of it."
  say ""
  say "  ${BOLD}2) Your local network (Wi-Fi/LAN)${RST}"
  say "     Other devices on your network reach http://<this-computer-ip>:$port_val — handy to review"
  say "     from your phone at home. Plain HTTP (no HTTPS); use only on a network you trust."
  say ""
  say "  ${BOLD}3) A shareable internet link — Cloudflare${RST}  (no router setup, no account)"
  say "     Downloads Cloudflare's free 'cloudflared' (~35 MB, official) and gives you a public"
  say "     https://…trycloudflare.com link when you start. Simplest way to send someone a link."
  say "     The link is a new one each time you start the app."
  say ""
  say "  ${BOLD}4) A shareable internet link — Tailscale${RST}  (stable link, needs a free account)"
  say "     A permanent https://…ts.net link. You install Tailscale, sign in, and turn on Funnel"
  say "     once; the link then stays the same. Whoever you send it to needs nothing installed."
  say ""
  case "$(ask_val 'Choose 1-4' '1')" in
    2) share_val="lan"; host_val="0.0.0.0"
       warn "Local-network mode has no HTTPS — only use it on a network you trust." ;;
    3) share_val="cloudflare" ;;
    4) share_val="tailscale" ;;
    *) share_val="local" ;;
  esac
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
  say "I'll ask three quick things. After the last one you'll get a summary and can redo them all."
  # Default the owner-admin to the account running the install (SUDO_USER if run via sudo), not a
  # hardcoded name — this is a tool other people install for themselves.
  default_admin="${SUDO_USER:-$(id -un)}"; [ -n "$default_admin" ] || default_admin="admin"
  # Loop so a typo is fixable: answer "no" at the summary to go back and re-enter everything.
  while :; do
    # ── Port ──
    say ""
    say "${BOLD}Port${RST} — the number in the web address, e.g. http://localhost:${BOLD}3458${RST}."
    say "Keep the default unless 3458 is already used by another program."
    port_val="$(ask_val 'Port' '3458')"
    case "$port_val" in ''|*[!0-9]*) warn "That's not a whole number — let's try again."; continue ;; esac
    { [ "$port_val" -ge 1 ] && [ "$port_val" -le 65535 ]; } || { warn "Port must be 1–65535 — let's try again."; continue; }

    # ── Admin username ──
    say ""
    say "${BOLD}Admin username${RST} — a NAME for the owner account (e.g. '$default_admin'). ${BOLD}This is NOT a password.${RST}"
    say "You'll choose the password later, the first time you log in. Lowercase, no spaces."
    admin_val="$(ask_val 'Admin username' "$default_admin")"

    # ── How people reach it ──
    ask_reach    # sets host_val + share_val

    # ── Review & confirm (answer "no" to go back and redo all three) ──
    say ""
    say "${BOLD}Please check these:${RST}"
    say "  Port:           ${BOLD}$port_val${RST}"
    say "  Admin username: ${BOLD}$admin_val${RST}  (you'll set its password on first login)"
    say "  Reachable via:  ${BOLD}$(reach_label "$share_val" "$port_val")${RST}"
    say ""
    if ask_yn "Is this correct?" Y; then break; fi
    say ""
    info "No problem — let's go through them again."
  done
  secret="$(node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("hex"))')"
  ( umask 077; cat > "$ENV_FILE" <<EOF
PORT=$port_val
HOST=$host_val
SESSION_SECRET=$secret
ADMIN_USER=$admin_val
SHARE=$share_val
EOF
  )
  # Persist DATA_DIR/UPLOADS_DIR only when overridden, so the booted service (which reads them via
  # dotenv from .env, NOT from the installer's shell env) stores data where setup actually prepared it.
  if [ "$DATA_DIR_RESOLVED" != "$REPO_DIR/data" ]; then printf 'DATA_DIR=%s\n' "$DATA_DIR_RESOLVED" >> "$ENV_FILE"; fi
  if [ "$UPLOADS_DIR_RESOLVED" != "$REPO_DIR/uploads" ]; then printf 'UPLOADS_DIR=%s\n' "$UPLOADS_DIR_RESOLVED" >> "$ENV_FILE"; fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  ok ".env written (random SESSION_SECRET; admin=$admin_val; reach=$share_val; PORT=$port_val)"
fi

# read effective values back for the service + final message (simple KEY=VALUE lines)
get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }
PORT_VAL="$(get_env PORT)";       PORT_VAL="${PORT_VAL:-3458}"
HOST_VAL="$(get_env HOST)";       HOST_VAL="${HOST_VAL:-127.0.0.1}"
ADMIN_VAL="$(get_env ADMIN_USER)"; ADMIN_VAL="${ADMIN_VAL:-james}"
SHARE_VAL="$(get_env SHARE)";     SHARE_VAL="${SHARE_VAL:-local}"
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
elif [ "$SHARE_VAL" = cloudflare ] || [ "$SHARE_VAL" = tailscale ]; then
  # A boot service runs only `node server.js` — it never recreates the tunnel/link. Offering
  # "start on boot" here would mislead a share-mode user into thinking their link stays live.
  info "You chose a shareable link, which runs from this launcher window — skipping the boot-service step."
  say "  (A boot service would start alsegno locally on boot, but would NOT recreate your public link.)"
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

# ── shareable-link helpers (SHARE=cloudflare / tailscale) ────
CF_BIN=""; APP_BG_PID=""; CF_BG_PID=""; CF_LOG=""
# Stop whatever WE started (empty PIDs are harmless) and remove the tunnel log. Every command is
# `|| true` so the trap can't end on a failing `kill` (which under set -e would skip the rm + leak it).
share_cleanup() { kill $CF_BG_PID 2>/dev/null || true; kill $APP_BG_PID 2>/dev/null || true; { [ -n "$CF_LOG" ] && rm -f "$CF_LOG" 2>/dev/null; } || true; }
# Tear down a FAILED share attempt and drop the trap, so the caller can cleanly start the app locally.
fail_share_to_local() { trap - EXIT INT TERM HUP; share_cleanup; CF_BG_PID=""; APP_BG_PID=""; CF_LOG=""; }

# ── LAN / port-forward sharing (used when a tunnel can't be created) ──
ext_ip() { curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true; }   # this machine's public IP (empty if offline / no curl)
lan_ip() {
  if [ "$PLATFORM" = macos ]; then ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  else hostname -I 2>/dev/null | awk '{print $1; exit}'; fi
}
set_env_kv() {   # persist KEY=VALUE in .env (replace the existing line or append)
  local k="$1" v="$2" tmp; [ -f "$ENV_FILE" ] || return 0
  if grep -qE "^$k=" "$ENV_FILE" 2>/dev/null; then
    tmp="$(mktemp)"; sed "s|^$k=.*|$k=$v|" "$ENV_FILE" > "$tmp" && cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi
}
print_share_lan() {   # $1=1 → we've switched to LAN mode for good (mention how to retry a tunnel)
  local lan ext; lan="$(lan_ip)"; ext="$(ext_ip)"
  say ""
  say "${BOLD}To share alsegno without a tunnel:${RST}"
  [ -n "$lan" ] && say "  • Same Wi-Fi / network:  ${BOLD}http://$lan:$PORT_VAL${RST}  (no setup needed)"
  if [ -n "$ext" ]; then say "  • Over the internet:     ${BOLD}http://$ext:$PORT_VAL${RST}"
  else                   say "  • Over the internet:     http://<your-public-IP>:$PORT_VAL"; fi
  say "       → first forward port ${BOLD}$PORT_VAL${RST} on your router to this computer, then send that link."
  warn "  Internet sharing this way is plain HTTP (no HTTPS) and needs router port-forwarding"
  warn "  (it won't work behind carrier-grade NAT). alsegno's login still gates access — share only with people you trust."
  [ "${1:-0}" = 1 ] && say "  Future launches use this local-network mode — set SHARE=cloudflare or SHARE=tailscale in .env to try a tunnel again."
  return 0
}
# Rebind to the LAN (0.0.0.0) and run the app HERE with port-forward sharing info. $1=1 persists SHARE=lan
# so the (failing) tunnel isn't retried on the next launch.
run_lan_share() {
  if [ -n "$APP_BG_PID" ]; then
    kill "$APP_BG_PID" 2>/dev/null || true; APP_BG_PID=""
    for _ in $(seq 1 50); do port_in_use 127.0.0.1 "$PORT_VAL" || break; sleep 0.1; done   # wait for the loopback bind to release before rebinding to 0.0.0.0
  fi
  HOST_VAL=0.0.0.0
  [ "${1:-0}" = 1 ] && { set_env_kv HOST 0.0.0.0; set_env_kv SHARE lan; }
  print_share_lan "${1:-0}"
  if port_in_use "$HOST_VAL" "$PORT_VAL"; then
    say ""; ok "alsegno is already running. Opening http://localhost:$PORT_VAL …"; open_url "http://localhost:$PORT_VAL"; return 0
  fi
  say ""
  ok "${BOLD}Starting alsegno.${RST} Keep this window open while you use it; press Ctrl+C (or close it) to stop."
  ( for _ in $(seq 1 150); do (exec 3<>"/dev/tcp/127.0.0.1/$PORT_VAL") 2>/dev/null && { exec 3>&- 3<&-; open_url "http://localhost:$PORT_VAL"; break; }; sleep 0.2; done ) &
  say ""
  HOST=0.0.0.0 npm start
}
# Start the app in the background if nothing already serves the port (so a tunnel can run in the
# foreground). Sets APP_BG_PID when we start it. The caller installs the cleanup trap BEFORE this, so a
# Ctrl+C during the startup wait can't orphan node.
ensure_app_running() {
  port_in_use "$HOST_VAL" "$PORT_VAL" && return 0
  ok "Starting alsegno…"
  "$NODE_BIN" "$REPO_DIR/server.js" >"$DATA_DIR_RESOLVED/alsegno.log" 2>&1 &
  APP_BG_PID=$!
  for _ in $(seq 1 150); do port_in_use "$HOST_VAL" "$PORT_VAL" && return 0; sleep 0.2; done
  warn "alsegno didn't start (see $DATA_DIR_RESOLVED/alsegno.log)."; return 1
}
# Download Cloudflare's cloudflared into ./bin if needed; sets CF_BIN. Validates with --version so a
# truncated download is never cached and re-run forever (the next launch re-fetches instead).
ensure_cloudflared() {
  if have cloudflared; then CF_BIN="cloudflared"; return 0; fi
  local bindir="$REPO_DIR/bin"; CF_BIN="$bindir/cloudflared"
  if [ -x "$CF_BIN" ] && "$CF_BIN" --version >/dev/null 2>&1; then return 0; fi
  rm -f "$CF_BIN" 2>/dev/null || true
  mkdir -p "$bindir"
  local arch
  case "$(uname -m)" in
    x86_64|amd64)  arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l|armv6l) arch=arm ;;
    *) warn "No automatic cloudflared build for CPU '$(uname -m)' — install cloudflared yourself."; return 1 ;;
  esac
  local base="https://github.com/cloudflare/cloudflared/releases/latest/download"
  info "Downloading Cloudflare cloudflared (~35 MB, official)…"
  if [ "$PLATFORM" = macos ]; then
    have curl || { warn "curl not found."; return 1; }
    curl -fsSL -o "$bindir/cf.tgz" "$base/cloudflared-darwin-$arch.tgz" || { warn "Download failed."; return 1; }
    tar xzf "$bindir/cf.tgz" -C "$bindir" 2>/dev/null; rm -f "$bindir/cf.tgz"
  elif have curl; then
    curl -fsSL -o "$CF_BIN" "$base/cloudflared-linux-$arch" || { warn "Download failed."; return 1; }
  elif have wget; then
    wget -qO "$CF_BIN" "$base/cloudflared-linux-$arch" || { warn "Download failed."; return 1; }
  else
    warn "Need curl or wget to download cloudflared."; return 1
  fi
  chmod +x "$CF_BIN" 2>/dev/null || true
  "$CF_BIN" --version >/dev/null 2>&1 && return 0
  warn "The downloaded cloudflared isn't runnable (incomplete download?). Removing it — try again."
  rm -f "$CF_BIN" 2>/dev/null || true; return 1
}
# Run the app + a Cloudflare quick tunnel and print the public link. On any failure it tears down what
# it started and returns non-zero so the caller falls back to a local run.
launch_with_cloudflare() {
  trap 'share_cleanup' EXIT INT TERM HUP     # installed BEFORE starting node so Ctrl+C can't orphan it
  if ! ensure_cloudflared; then
    warn "Couldn't download/run cloudflared — using local-network sharing instead."
    trap - EXIT INT TERM HUP; run_lan_share 1; return 0
  fi
  ensure_app_running || { fail_share_to_local; return 1; }
  say ""
  ok "Creating your public link…"
  CF_LOG="$(mktemp)"
  "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT_VAL" --no-autoupdate >"$CF_LOG" 2>&1 &
  CF_BG_PID=$!
  local url=""
  for _ in $(seq 1 150); do
    url="$(grep -oE 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' "$CF_LOG" | head -1)"   # require a multi-word host so cloudflared's api.trycloudflare.com (logged on failure) is never matched
    [ -n "$url" ] && break
    kill -0 "$CF_BG_PID" 2>/dev/null || break
    sleep 0.3
  done
  if [ -z "$url" ]; then            # tunnel never came up — fall back to LAN + port-forward sharing
    warn "Couldn't create the public Cloudflare link. cloudflared reported:"
    tail -8 "$CF_LOG" >&2
    say "  (Usually a network/firewall blocking the tunnel, or Cloudflare being busy.)"
    kill "$CF_BG_PID" 2>/dev/null || true; { [ -n "$CF_LOG" ] && rm -f "$CF_LOG"; } 2>/dev/null || true; CF_BG_PID=""
    trap - EXIT INT TERM HUP        # cloudflared handled; run_lan_share owns the app from here
    run_lan_share 1                 # rebind to the LAN, remember it (don't retry the failing tunnel next time)
    return 0
  fi
  say ""
  say "${GRN}${BOLD}========================================================${RST}"
  say "  ${BOLD}Send this link to anyone you want to review:${RST}"
  say ""
  say "      ${BOLD}${GRN}$url${RST}"
  say ""
  say "  (On this computer: http://localhost:$PORT_VAL)"
  say "${GRN}${BOLD}========================================================${RST}"
  open_url "$url"
  say ""
  say "Keep this window open while you share. Close it (or press Ctrl+C) to stop alsegno and the link."
  wait "$CF_BG_PID" 2>/dev/null || true
  return 0   # the tunnel session ran; don't fall back to a local relaunch
}
# Publish over Tailscale Funnel (stable link). Returns non-zero to fall back to local.
launch_with_tailscale() {
  if ! have tailscale; then
    warn "Tailscale isn't installed. For a stable Tailscale link later: install it"
    say "  (https://tailscale.com/download), run 'tailscale up', then re-run this. For now, sharing locally:"
    run_lan_share 0; return 0
  fi
  if ! tailscale status >/dev/null 2>&1; then
    warn "Tailscale is installed but you're not signed in. Run 'tailscale up', then re-run this. For now, sharing locally:"
    run_lan_share 0; return 0
  fi
  trap 'share_cleanup' EXIT INT TERM HUP     # before ensure_app_running so Ctrl+C can't orphan node
  ensure_app_running || { fail_share_to_local; return 1; }
  say ""
  ok "Publishing alsegno over Tailscale Funnel…"
  say "  If Tailscale asks you to turn on Funnel, follow the link it prints, then it'll show your URL."
  say "  Keep this window open while you share; press Ctrl+C to stop."
  tailscale funnel "$PORT_VAL" || true
  return 0   # funnel session ran; don't fall back to a local relaunch
}

if [ "$LAUNCH" = 1 ]; then
  shared=0
  case "$SHARE_VAL" in
    cloudflare) if launch_with_cloudflare; then shared=1; fi ;;
    tailscale)  if launch_with_tailscale;  then shared=1; fi ;;
    lan)        run_lan_share 0 || true; shared=1 ;;   # || true: keep set -e off inside the helper
  esac
  # If a share mode was chosen but couldn't be set up, say so before falling through to a local run —
  # otherwise the user who wanted a link is silently left with a localhost-only app.
  if [ "$shared" != 1 ] && { [ "$SHARE_VAL" = cloudflare ] || [ "$SHARE_VAL" = tailscale ]; }; then
    say ""
    warn "Couldn't set up the public link — starting alsegno locally instead (reachable only on this computer)."
    say "  Re-run this when you're back online to try the link again, or change SHARE in .env."
  fi
  if [ "$shared" = 1 ]; then
    :   # the share helper ran the app + tunnel and has now returned (user stopped it)
  elif [ "$SERVICE_STARTED" = 1 ]; then
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
