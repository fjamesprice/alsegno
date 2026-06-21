# Installing Album Tracker

Album Tracker is a self-contained Node.js app — a single Express server plus a single
HTML/JS page, backed by SQLite. It has **no build step** and only one external runtime
dependency: **ffmpeg**. You can run it on your own laptop, a home server, or a VPS.

There is no separate database server to set up: data lives in `data/tracker.db` (SQLite)
and uploaded audio in `uploads/`, both created on first run.

---

## Prerequisites

| Requirement        | Why | Check |
| ------------------ | --- | ----- |
| **Node.js ≥ 18**   | Runs the server. | `node -v` |
| **ffmpeg + ffprobe** on `PATH` | Every upload is transcoded/analysed (waveform, LUFS, true-peak). Without them, uploads fail. | `ffmpeg -version` |

The installer checks both and prints OS-specific install hints if either is missing.

Installing ffmpeg manually, if you prefer:

- **Debian/Ubuntu:** `sudo apt-get install -y ffmpeg`
- **Fedora/RHEL:** `sudo dnf install -y ffmpeg` (may need RPM Fusion)
- **Arch:** `sudo pacman -S ffmpeg`
- **macOS:** `brew install ffmpeg`
- **Windows:** `winget install Gyan.FFmpeg` (or `choco install ffmpeg`), then open a new terminal

---

## Quick start

This is the **native install** (Node + ffmpeg on the host). Prefer containers? Skip to
[Option B: Run with Docker](#option-b-run-with-docker) — ffmpeg and Node come baked into the image.

Clone the repo, then run the installer for your OS.

### Linux / macOS

```bash
git clone <your-repo-url> album-tracker
cd album-tracker
./install.sh
```

### Windows (PowerShell)

```powershell
git clone <your-repo-url> album-tracker
cd album-tracker
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer will:

1. Verify Node ≥ 18 and ffmpeg/ffprobe (with install hints if missing).
2. `npm install` the dependencies.
3. Create `data/` and `uploads/`.
4. Generate a `.env` with a **random `SESSION_SECRET`**, asking you for the port, the admin
   username, and whether to expose the app on your LAN.
5. Optionally install a **background service** that starts the app on boot
   (systemd on Linux, launchd on macOS, NSSM on Windows).
6. Print the URL to open.

When it finishes, open the printed URL and **log in as your admin username**. The very first
login sets that account's password permanently (trust-on-first-use — there is no separate
sign-up step). From the admin pages you can then add users and create projects.

### Installer options

| Flag (sh / ps1)            | Effect |
| -------------------------- | ------ |
| `--yes` / `-Yes`           | Non-interactive: accept every default (port 3458, admin `james`, localhost-only, install service). |
| `--no-service` / `-NoService` | Do everything except install/start a service; just print the start command. |
| `-h` / `--help`            | (sh) Show usage. |

Re-running the installer is safe: an existing `.env` is **never overwritten**, and the
service step backs off if the port is already in use.

---

## Option B: Run with Docker

If you'd rather not install Node and ffmpeg on the host, run Album Tracker in a container. You
need **Docker** with the Compose plugin (check with `docker compose version`). The image bundles
Node 22 and ffmpeg — nothing else is required on the host (you can skip the Prerequisites above).

```bash
git clone <your-repo-url> album-tracker
cd album-tracker

# A long random secret that signs session cookies (keep it stable — changing it logs everyone out):
export SESSION_SECRET=$(openssl rand -hex 48)
# Optional: first admin username (default "admin") and host port (default 3458):
export ADMIN_USER=james
export PORT=3458

docker compose up -d --build
```

Then open **http://localhost:3458** (or whichever `PORT` you chose) and log in as your
`ADMIN_USER` — the first login sets that account's password permanently (trust-on-first-use).

Instead of `export`ing the variables you can drop them in a **`.env` file** next to
`docker-compose.yml`:

```
SESSION_SECRET=<paste a long random hex string>
ADMIN_USER=james
PORT=3458
```

`SESSION_SECRET` is **required**: `docker compose up` fails fast with a reminder if it is unset.

**Data & persistence.** Two named Docker volumes hold your data across restarts and rebuilds:
`at-data` (the SQLite database — including its WAL and the sessions table) and `at-uploads` (all
transcoded audio/video). They survive `docker compose down`. Remove them deliberately with
`docker compose down -v`, which **permanently deletes all data**.

**Managing it:**
```bash
docker compose ps                 # status + health
docker compose logs -f            # live logs
docker compose restart            # restart the container
docker compose down               # stop & remove the container (volumes/data kept)
```

**Updating:** `git pull`, then `docker compose up -d --build` rebuilds the image and recreates
the container; your volumes (and data) are untouched. The schema migrates itself on startup.

**Notes & caveats:**
- **One writer only.** SQLite allows a single writer, so run exactly one replica — don't
  `docker compose up --scale album-tracker=2` or set `deploy.replicas` > 1.
- **Exposing on your network.** The compose file publishes the port on all host interfaces, so
  the app is reachable from other devices over **plain HTTP (no TLS)** — see the network warning
  below. Only do this on a trusted network. To bind to this machine only, change the port mapping
  to `"127.0.0.1:${PORT:-3458}:3458"`, and for internet-facing use put a reverse proxy with HTTPS
  in front.
- **The container runs as a non-root user (uid 1000).** With the default *named* volumes this is
  seamless. If you instead bind-mount host directories for `/data` or `/uploads`, make them
  writable by uid 1000 (`sudo chown -R 1000:1000 ./your-dir`) or the app can't write the database
  and uploads.
- **Compose auto-reads a `.env` next to `docker-compose.yml`** for `${SESSION_SECRET}`/`${PORT}`
  substitution — the *same* filename the native installer (Option A) writes. So if you run Docker
  from a directory that already holds an Option-A `.env`, the container reuses **that** install's
  session secret and host port. It's harmless if the port is already taken (Docker just refuses to
  start — it can't disturb a running native instance), but to run both on one machine use a
  separate clone, or set a distinct `SESSION_SECRET` and `PORT` for the container.
- **ffmpeg lives inside the image** — you do **not** need it on the host for the Docker route.

---

## Configuration (`.env`)

The installer writes these; you can edit `.env` by hand and restart afterwards. See
`.env.example` for the annotated template.

| Key              | Default      | Meaning |
| ---------------- | ------------ | ------- |
| `PORT`           | `3458`       | Port the server listens on. |
| `HOST`           | `127.0.0.1`  | Bind address. `127.0.0.1` = this machine only. `0.0.0.0` = reachable from other devices on your network. |
| `SESSION_SECRET` | *(random)*   | Signs session cookies. Keep it secret; changing it logs everyone out. |
| `ADMIN_USER`     | `admin`      | Username of the first/owner admin, seeded on first run. The install scripts default it to your OS account name; the Docker image defaults to `admin`. |
| `DATA_DIR`       | `./data`     | Where `tracker.db` lives. Optional. |
| `UPLOADS_DIR`    | `./uploads`  | Where uploaded/transcoded audio lives (this is the "media store"). Optional. |

### ⚠️ Exposing on a network (`HOST=0.0.0.0`)

Binding to `0.0.0.0` lets other devices on the same network reach the app — handy for, say,
a client reviewing a mix from their phone. But the bare port speaks **plain HTTP with no
TLS**, so only do this on a network you trust. For internet-facing deployments, keep
`HOST=127.0.0.1` and put a reverse proxy (nginx, Caddy) with HTTPS in front of it — the app
uses relative URLs throughout, so it works unchanged behind a sub-path proxy.

---

## Running & managing the service

If you let the installer set up a service, it's already running and will start on boot.

**Linux (systemd):**
```bash
sudo systemctl status album-tracker      # is it running?
sudo systemctl restart album-tracker     # apply changes / after editing .env
sudo systemctl stop album-tracker
journalctl -u album-tracker -f           # live logs
```

**macOS (launchd):**
```bash
launchctl unload ~/Library/LaunchAgents/com.albumtracker.server.plist   # stop
launchctl load   ~/Library/LaunchAgents/com.albumtracker.server.plist   # start
# logs: data/album-tracker.log and data/album-tracker.err.log
```

**Windows (NSSM):**
```powershell
nssm restart AlbumTracker
nssm stop AlbumTracker
nssm remove AlbumTracker confirm   # uninstall the service
# logs: data\album-tracker.log and data\album-tracker.err.log
```

**No service (manual / development):**
```bash
npm start         # runs node server.js in the foreground; Ctrl-C to stop
```

**pm2 (if you use it):** the installer falls back to pm2 when no native service manager is
available. `pm2 restart album-tracker`, `pm2 logs album-tracker`, and `pm2 startup` to enable
boot start.

---

## Updating

```bash
git pull
npm install          # in case dependencies changed
# then restart the service, e.g.:
sudo systemctl restart album-tracker
```

The database schema migrates itself on startup (additive only — no data loss).

---

## Uninstalling the service

- **systemd:** `sudo systemctl disable --now album-tracker && sudo rm /etc/systemd/system/album-tracker.service && sudo systemctl daemon-reload`
- **launchd:** `launchctl unload ~/Library/LaunchAgents/com.albumtracker.server.plist && rm ~/Library/LaunchAgents/com.albumtracker.server.plist`
- **NSSM:** `nssm remove AlbumTracker confirm`

Your `data/` and `uploads/` are left untouched — delete them by hand if you want the data gone.

---

## Testing changes without touching live data

The DB path and uploads dir are env-overridable, so you can run a throwaway instance on a
spare port against a temp database without disturbing a running install:

```bash
PORT=3999 DATA_DIR=/tmp/at-test/data UPLOADS_DIR=/tmp/at-test/uploads \
  SESSION_SECRET=test ADMIN_USER=tester node server.js
```

Note that the seeded users use **trust-on-first-use** passwords — the first login for an
account sets its password — so a throwaway instance needs its own fresh login, and you can't
reuse a production password against it.

---

## Troubleshooting

- **"uploads fail" / nothing happens after picking a file** — ffmpeg/ffprobe aren't on `PATH`.
  Install them (see Prerequisites) and restart.
- **`npm install` fails compiling `better-sqlite3`** — you need a C/C++ toolchain:
  `build-essential` + `python3` (Linux), `xcode-select --install` (macOS), or the
  "Desktop development with C++" Visual Studio Build Tools + Python 3 (Windows).
- **Everyone got logged out after an update** — expected once when upgrading to the persistent
  session store, or any time `SESSION_SECRET` changes. Just log in again.
- **Can't reach it from another device** — set `HOST=0.0.0.0` in `.env`, restart, and check
  your OS firewall allows the port (read the warning above first).
