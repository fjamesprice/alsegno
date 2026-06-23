require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3458;
// Bind address. Default 127.0.0.1 = the prod posture (nginx proxies to localhost). A standalone
// install (Phase 5) sets HOST=0.0.0.0 to be reachable from other devices on the LAN — install.sh
// prompts for that and writes it to .env. Loopback stays the safe default for anyone who doesn't.
const HOST = process.env.HOST || '127.0.0.1';

// Trust proxy: OFF by default so a directly-exposed instance (HOST=0.0.0.0 or a share tunnel) can't
// be fooled by a spoofed X-Forwarded-For — which would otherwise defeat the login rate limiter and
// mis-mark the Secure cookie. Operators who actually front the app with nginx/Caddy set TRUST_PROXY=1
// (the hop count). This single value drives BOTH app.set('trust proxy') and the rate-limiter IP key.
const TRUST_PROXY = (() => {
  const v = (process.env.TRUST_PROXY || '').trim();
  if (!v || v === '0' || v.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // 'loopback', a subnet, etc. — passed straight through to Express
})();

// HSTS is OFF unless an operator opts in (ENABLE_HSTS=1), and even then only sent over a real HTTPS
// request. It's a browser-cached "https-only" commitment; behind a TLS-terminating proxy, prefer
// configuring it there. See .env.example for the plain-English rationale.
const ENABLE_HSTS = /^(1|true|yes|on)$/i.test((process.env.ENABLE_HSTS || '').trim());

// ── Directories ──────────────────────────────────────────────
// Env-overridable so a throwaway test instance can point at a temp DB/uploads dir
// (DATA_DIR=/tmp/at-test/data UPLOADS_DIR=/tmp/at-test/uploads PORT=3999 node server.js)
// without touching the live store. Unset in prod ⇒ the original __dirname paths.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
// Owner-only by default: the SQLite DB and uploaded media must not be world-readable on a shared host.
// umask covers every file the process creates (DB, WAL/SHM, uploads, temp scratch); the chmods tighten
// the two dirs in case they pre-existed with looser permissions. Opt out with STRICT_FILE_PERMS=0 for
// unusual deployments (e.g. a Docker bind-mount a non-root host user must read directly).
const STRICT_FILE_PERMS = !/^(0|false|no|off)$/i.test((process.env.STRICT_FILE_PERMS || '').trim());
if (STRICT_FILE_PERMS) process.umask(0o077);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (STRICT_FILE_PERMS) { try { fs.chmodSync(DATA_DIR, 0o700); } catch {} try { fs.chmodSync(UPLOADS_DIR, 0o700); } catch {} }

// Upload safety caps (disk-fill DoS). The free-space margin always applies; the global byte quota and
// per-track revision cap are operator-tunable. UPLOAD_FREE_SPACE_MARGIN_MB = headroom to always keep
// free; MAX_UPLOAD_BYTES_GB = 0 ⇒ unlimited; MAX_REVISIONS_PER_TRACK caps revisions per track.
const UPLOAD_MARGIN_BYTES = Math.max(0, Number(process.env.UPLOAD_FREE_SPACE_MARGIN_MB) || 500) * 1024 * 1024;
const MAX_UPLOAD_BYTES = Math.max(0, Number(process.env.MAX_UPLOAD_BYTES_GB) || 0) * 1024 * 1024 * 1024; // 0 = unlimited
const MAX_REVISIONS_PER_TRACK = Math.max(1, Number(process.env.MAX_REVISIONS_PER_TRACK) || 100);

// ── Database ─────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'tracker.db'));
db.pragma('journal_mode = WAL');
// DB + its WAL/SHM sidecars owner-only (they hold session rows and all app content).
if (STRICT_FILE_PERMS) for (const f of ['tracker.db', 'tracker.db-wal', 'tracker.db-shm']) { try { fs.chmodSync(path.join(DATA_DIR, f), 0o600); } catch {} }
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username   TEXT PRIMARY KEY,
    pw_hash    TEXT,
    role       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    doneness    INTEGER NOT NULL DEFAULT 0,
    done_revision_id INTEGER,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS revisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id      INTEGER NOT NULL,
    rev_number    INTEGER NOT NULL,
    stored_name   TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type     TEXT DEFAULT 'audio/mpeg',
    size          INTEGER DEFAULT 0,
    duration      REAL DEFAULT 0,
    peaks         TEXT DEFAULT '[]',
    notes         TEXT DEFAULT '',
    uploaded_by   TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id    INTEGER NOT NULL,
    revision_id INTEGER,
    author      TEXT NOT NULL,
    ts          REAL,
    body        TEXT NOT NULL,
    resolved    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
    FOREIGN KEY (revision_id) REFERENCES revisions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS seen (
    username      TEXT NOT NULL,
    track_id      INTEGER NOT NULL,
    last_seen_rev INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (username, track_id)
  );

  -- Phase 3a: projects model. A project owns a set of tracks; 'song' holds exactly one
  -- track (no album title/ordering UI), 'album' holds many. art_stored_name backs album
  -- art (singles + albums). The existing single album is folded in via the backfill below.
  CREATE TABLE IF NOT EXISTS projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL DEFAULT 'album',      -- 'album' | 'song'
    media_type      TEXT NOT NULL DEFAULT 'audio',      -- 'audio' | 'video'
    title           TEXT NOT NULL,
    art_stored_name TEXT,
    owner           TEXT,                               -- engineer/admin who created it
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  -- Access control: which users can reach which projects. Membership rows cascade away with
  -- the project (new table ⇒ real FK, unlike the ALTER-added columns below). No FK on
  -- username — users are deactivated, never hard-deleted, so memberships outlive nothing.
  CREATE TABLE IF NOT EXISTS project_users (
    project_id INTEGER NOT NULL,
    username   TEXT NOT NULL,
    PRIMARY KEY (project_id, username),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`);

// Seed the initial admin (TOFU — pw_hash stays NULL until first login sets it).
// A fresh install gets exactly one admin from ADMIN_USER (default 'james'); everyone else is
// added later via the admin UI (Phase 3b/3c). On the existing prod DB this is a no-op (james
// already exists), and noah is no longer seeded here — it already exists, and its legacy
// 'artist' role is migrated to 'client' in the backfill below.
const ADMIN_USER = (process.env.ADMIN_USER || 'james').trim().toLowerCase();
db.prepare('INSERT OR IGNORE INTO users (username, role) VALUES (?, ?)').run(ADMIN_USER, 'admin');

// Seed album title. Read once by the Phase 3a backfill to title the migrated album project;
// no longer surfaced by any route (the project's own title is authoritative from 3b on).
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('album_title', ?)")
  .run('Noah Praise God — Album');

// Instance settings (Phase 3b–3d). null_test_visible: player shows the null-test button (default OFF).
// keep_lossless: uploads keep the original file for lossless download. show_deleted_notes: admins
// can see soft-deleted notes. video_enabled: gate video projects (Phase 6, not built yet). media_root
// is intentionally NOT a runtime setting — it stays env-driven (UPLOADS_DIR), a Phase-5 install concern.
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('null_test_visible', '0')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('keep_lossless', '0')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('show_deleted_notes', '0')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('video_enabled', '0')").run();
// auto_update_check: periodically check whether this install is behind its git origin and notify
// admins (Cluster E — check-and-notify only; never pulls/installs/restarts). The companion
// 'update_status' row is the cached result (written on each check, served to admins by bootstrap).
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_update_check', '1')").run();

// Migration: loudness/peak metering columns on revisions
{
  const cols = db.prepare('PRAGMA table_info(revisions)').all().map(c => c.name);
  const add = (name, decl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE revisions ADD COLUMN ${name} ${decl}`); };
  add('lufs_i', 'REAL');                 // integrated LUFS (whole track)
  add('lufs_lra', 'REAL');               // loudness range (LU)
  add('true_peak', 'REAL');              // true peak (dBTP / dBFS)
  add('st_interval', 'REAL DEFAULT 0');  // seconds per short-term sample
  add('st_series', "TEXT DEFAULT '[]'"); // short-term LUFS time-series
  add('peak_interval', 'REAL DEFAULT 0');  // seconds per peak-meter sample
  add('peak_series', "TEXT DEFAULT '[]'"); // fine-grained sample-peak series (dBFS)
}

// Migration (Phase 3d): keep-lossless original + soft-deleted comments.
//   revisions.original_stored_name — on-disk name of the kept lossless source (NULL = none).
//   comments.deleted_at — soft-delete timestamp (NULL = live). Replaces the hard DELETE so notes
//                         are recoverable and admins can review them (show_deleted_notes).
{
  const rcols = db.prepare('PRAGMA table_info(revisions)').all().map(c => c.name);
  if (!rcols.includes('original_stored_name')) db.exec('ALTER TABLE revisions ADD COLUMN original_stored_name TEXT');
  const ccols = db.prepare('PRAGMA table_info(comments)').all().map(c => c.name);
  if (!ccols.includes('deleted_at')) db.exec('ALTER TABLE comments ADD COLUMN deleted_at TEXT');
}

// Migration: edited_at + parent_id on comments
//   edited_at — NULL until a note's body is edited
//   parent_id — NULL = top-level note; non-NULL = reply pointing at its parent note (Phase 2.2).
//   Bare INTEGER (no REFERENCES): reply cleanup is handled explicitly in the DELETE route,
//   matching the explicit-orphan philosophy used for revision deletes below.
{
  const cols = db.prepare('PRAGMA table_info(comments)').all().map(c => c.name);
  if (!cols.includes('edited_at')) db.exec('ALTER TABLE comments ADD COLUMN edited_at TEXT');
  if (!cols.includes('parent_id')) db.exec('ALTER TABLE comments ADD COLUMN parent_id INTEGER');
}

// Migration (Phase 3a): projects model — new columns on existing tables.
//   users.display_name — friendly name for the UI (NULL ⇒ fall back to username).
//   users.active       — 0 deactivates login without hard-deleting (keeps authored comments).
//   tracks.project_id  — which project a track belongs to. Bare INTEGER, no FK — deliberately
//                        matching the comments.parent_id choice above: columns added via ALTER
//                        get explicit cleanup in their routes, not a retro-fitted FK. So project
//                        delete (Phase 3b) must cascade tracks→revisions→comments explicitly.
{
  const ucols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!ucols.includes('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  if (!ucols.includes('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  const tcols = db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
  if (!tcols.includes('project_id')) db.exec('ALTER TABLE tracks ADD COLUMN project_id INTEGER');
  // Phase 3b: remember each user's last-opened project so login can jump straight back in.
  // Set ONLY server-side inside the access-checked GET /api/projects/:id, re-validated on every
  // open and filtered in bootstrap — a stale pointer at a revoked/deleted project can never
  // auto-open (it falls back to the project list). It is a hint, never an authorization.
  if (!ucols.includes('last_project_id')) db.exec('ALTER TABLE users ADD COLUMN last_project_id INTEGER');
  // Round 2 / Cluster A: one-time invite token for a TOFU-pending account. NULL = none/consumed.
  // A pending account (pw_hash NULL) with a non-NULL token can ONLY set its password via the
  // matching invite link's token (login hard-refuses otherwise). Existing NULL-pw_hash rows get a
  // NULL token here and are grandfathered as "token not required" so the bootstrap admin / any
  // pre-migration pending user isn't locked out. Additive + idempotent; independent of the 3a
  // backfill (guarded separately below), so it never re-fires it.
  if (!ucols.includes('first_login_token')) db.exec('ALTER TABLE users ADD COLUMN first_login_token TEXT');
  if (!ucols.includes('pw_changed_at')) db.exec('ALTER TABLE users ADD COLUMN pw_changed_at INTEGER');
}

// Migration (Phase 6): video revisions. For a video revision, `stored_name` holds the HQ
// H.264/AAC mp4 preview (the streamed asset — the draft schema's separate `video_stored_name`
// is folded into the existing `stored_name`, so the audio serve/download/cleanup paths work
// unchanged), `video_proxy_name` holds the 480p instant-scrub proxy, and fps/width/height
// describe the source. `media_kind` distinguishes 'audio' (default — every existing row) from
// 'video'. The audio loudness/peak columns are still populated from the video's audio track.
{
  const cols = db.prepare('PRAGMA table_info(revisions)').all().map(c => c.name);
  const add = (name, decl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE revisions ADD COLUMN ${name} ${decl}`); };
  add('media_kind', "TEXT NOT NULL DEFAULT 'audio'"); // 'audio' | 'video'
  add('video_proxy_name', 'TEXT');                    // low-q proxy for instant scrub (Phase 6c)
  add('fps', 'REAL');
  add('width', 'INTEGER');
  add('height', 'INTEGER');
}

// Migration (Phase 6 — audio-post model): in a VIDEO project the picture is a track-level asset and
// the audio mix is what gets revised. The video (HQ preview + 480p proxy + fps/dims/duration) lives on
// the TRACK, replaceable independently; each revision is an AUDIO mix that plays in sync with it.
// `is_orig_audio` flags the one revision auto-made from the video's own embedded audio ("Original
// audio"); uploaded mixes are v1.. The Phase-6 revisions.video_* columns above are now vestigial
// (revisions are audio again) — left in place per the additive-only migration policy.
{
  const tcols = db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
  const tadd = (name, decl) => { if (!tcols.includes(name)) db.exec(`ALTER TABLE tracks ADD COLUMN ${name} ${decl}`); };
  tadd('video_stored_name', 'TEXT');            // HQ H.264/AAC mp4 (the picture, streamed muted)
  tadd('video_proxy_name', 'TEXT');             // 480p proxy (mid tier — instant scrub / medium links)
  tadd('video_micro_name', 'TEXT');             // 240p ultra-low tier — instant start on slow/non-LAN links (Phase 6d)
  tadd('video_original_name', 'TEXT');          // uploaded filename (for display/download)
  tadd('video_original_stored_name', 'TEXT');   // kept lossless original video (keep_lossless)
  tadd('video_fps', 'REAL');
  tadd('video_width', 'INTEGER');
  tadd('video_height', 'INTEGER');
  tadd('video_duration', 'REAL');
  tadd('video_uploaded_by', 'TEXT');
  tadd('video_updated_at', 'TEXT');
  // Background-processing flags: a media upload responds immediately and transcodes in the background
  // (long video/audio can't reliably be held in one HTTP request), so Studio shows "processing…" until
  // an SSE 'change' lands. video_processing = a video is being processed; mix_processing = count of
  // audio-mix uploads in flight. Stale flags from a crash/restart are cleared on startup (below).
  tadd('video_processing', 'INTEGER NOT NULL DEFAULT 0');
  tadd('mix_processing', 'INTEGER NOT NULL DEFAULT 0');
  const rcols = db.prepare('PRAGMA table_info(revisions)').all().map(c => c.name);
  if (!rcols.includes('is_orig_audio')) db.exec("ALTER TABLE revisions ADD COLUMN is_orig_audio INTEGER NOT NULL DEFAULT 0");
}
// Clear any processing flags left set by a crash/restart mid-job (the in-flight transcode was lost).
db.exec('UPDATE tracks SET video_processing = 0, mix_processing = 0 WHERE video_processing <> 0 OR mix_processing <> 0');
// Video projects are never albums: a video project just holds one or more videos as 'song'-type
// tracks, with no album title/art/ordering. Demote any that an earlier build promoted to 'album'
// (the song→album flip on a 2nd-track add used to fire for video too). Idempotent.
db.exec("UPDATE projects SET type = 'song' WHERE media_type = 'video' AND type = 'album'");
// Sweep transient decode temp files orphaned by a crash/kill mid-analysis. computeWaveAndPeaks writes
// uploads/.wavtmp-<uuid>.f32 (a full-rate PCM decode — can be hundreds of MB) and unlinks it inline;
// if the process dies in between, nothing else references or reclaims it. No DB row points at these,
// so it's always safe to delete every one at startup. Scoped to UPLOADS_DIR (per-instance).
try {
  for (const f of fs.readdirSync(UPLOADS_DIR)) {
    if (/^\.wavtmp-.*\.f32$/.test(f)) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {} }
  }
} catch {}

// Indexes for the project-scoped lookups added in Phase 3b (membership-by-user, tracks-by-project).
// Created after the ALTER above so tracks.project_id exists; idempotent.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tracks_project ON tracks(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_users_user ON project_users(username);
`);

// One-time backfill (Phase 3a): fold the original single album into the projects model.
// Self-protecting + idempotent — it only fires when no project exists yet AND there are legacy
// tracks with no project_id (i.e. exactly the pre-Phase-3 prod DB). A fresh install (no tracks)
// creates nothing; once a project exists this branch is never taken again. The role rename runs
// unconditionally but is itself idempotent (only matches rows still tagged 'artist').
db.transaction(() => {
  // artist→client. Safe to run before the frontend understands 'client': nothing keys off the
  // 'artist' string — authorization checks only ever test role === 'admin'.
  db.prepare("UPDATE users SET role = 'client' WHERE role = 'artist'").run();

  const haveProjects = db.prepare('SELECT COUNT(*) AS v FROM projects').get().v;
  const orphanTracks = db.prepare('SELECT COUNT(*) AS v FROM tracks WHERE project_id IS NULL').get().v;
  if (!haveProjects && orphanTracks > 0) {
    const title = db.prepare("SELECT value FROM settings WHERE key = 'album_title'").get()?.value || 'Album';
    const owner = db.prepare("SELECT username FROM users WHERE role = 'admin' ORDER BY created_at, username LIMIT 1").get()?.username || ADMIN_USER;
    const pid = db.prepare("INSERT INTO projects (type, media_type, title, owner) VALUES ('album', 'audio', ?, ?)")
      .run(title, owner).lastInsertRowid;
    db.prepare('UPDATE tracks SET project_id = ? WHERE project_id IS NULL').run(pid);
    // Grant every existing user access to the migrated album (james + noah today).
    const grant = db.prepare('INSERT OR IGNORE INTO project_users (project_id, username) VALUES (?, ?)');
    for (const u of db.prepare('SELECT username FROM users').all()) grant.run(pid, u.username);
    console.log(`[migrate 3a] folded ${orphanTracks} track(s) into album project #${pid} "${title}" (owner ${owner})`);
  }
})();

// ── Auth (trust-on-first-use) ────────────────────────────────
// scrypt runs ASYNC (crypto.scrypt, not scryptSync): it's a deliberately expensive CPU-bound KDF, and
// the sync form would block Node's single event loop for the whole computation — so a burst of login
// attempts would serialize every other request behind it. Async hands the work to libuv's threadpool.
function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, (err, hash) =>
      err ? reject(err) : resolve(salt.toString('hex') + ':' + hash.toString('hex')));
  });
}
function verifyPassword(pw, stored) {
  return new Promise((resolve) => {
    if (!stored) return resolve(false);
    const [saltHex, hashHex] = stored.split(':');
    crypto.scrypt(pw, Buffer.from(saltHex, 'hex'), 64, (err, hash) => {
      if (err) return resolve(false);
      const expected = Buffer.from(hashHex, 'hex');
      resolve(hash.length === expected.length && crypto.timingSafeEqual(hash, expected));
    });
  });
}
// One-time invite token (Cluster A). 24 random bytes ⇒ 48 hex chars (≥16B entropy, NOT derived
// from SESSION_SECRET). Minted on user-create and password-reset; cleared the moment it sets a
// password. Compared in constant time so the login compare can't leak it char-by-char.
function mintInviteToken() { return crypto.randomBytes(24).toString('hex'); }
function tokenEquals(a, b) {
  const ab = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return ab.length > 0 && ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
// Minimum password strength, enforced whenever a password is SET (first-login or self-service change).
// Length-only by design for a small self-hosted tool; operators can raise the floor via MIN_PASSWORD_LEN.
const MIN_PASSWORD_LEN = Math.max(1, Number(process.env.MIN_PASSWORD_LEN) || 8);
function passwordPolicyError(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LEN) return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
  if (pw.length > 1024) return 'Password is too long (max 1024 characters).';
  return null;
}
// What we keep in the session cookie (and hand to the client) — never the pw_hash.
const sessionUser = u => ({ username: u.username, role: u.role, display_name: u.display_name || null });
// Instance setting as a boolean (missing key ⇒ default). Used by bootstrap so every role learns
// instance toggles (e.g. null_test_visible) even though GET /api/settings is admin-only.
const settingOn = (key, dflt = true) => { const v = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value; return v == null ? dflt : v === '1'; };
// Per-upload "keep the original" decision. The global keep_lossless setting forces it on for every
// upload; when that setting is OFF, an individual upload can still opt in via a keep_lossless form
// field (the Studio checkbox). So the per-request flag only ever ADDS keeping, never removes it.
function wantKeepLossless(req) {
  if (settingOn('keep_lossless', false)) return true;
  const v = String((req.body && req.body.keep_lossless) || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// ── Multer ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } }); // 1 GB
// Album art: small cap + image-only filter (ffmpeg then re-encodes to a downscaled jpg, which also validates it).
const uploadImage = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)) });
// Wrap the art upload so multer's own errors (e.g. over the 25 MB cap) become a clean JSON 413/400
// instead of Express's default HTML 500 — so the client toast shows the real reason.
function artUpload(req, res, next) {
  uploadImage.single('file')(req, res, err => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image too large (max 25 MB)' : 'Upload failed' });
    next();
  });
}

// ── Upload disk-fill guard ───────────────────────────────────
// Runs BEFORE multer writes the temp file (keyed on Content-Length) so an oversized upload is rejected
// before it can touch the disk. Always enforces a free-space margin; optionally a global byte quota
// and a per-track revision cap. statfs/readdir are best-effort — if unavailable we fail open, since
// multer's own 1 GB fileSize limit still bounds any single write.
function freeSpaceFor(bytes) {
  try { const st = fs.statfsSync(UPLOADS_DIR); return (st.bavail * st.bsize) - UPLOAD_MARGIN_BYTES >= bytes; }
  catch { return true; }
}
function uploadsDirBytes() {
  let total = 0;
  try { for (const f of fs.readdirSync(UPLOADS_DIR)) { try { total += fs.statSync(path.join(UPLOADS_DIR, f)).size; } catch {} } } catch {}
  return total;
}
function uploadGuard(opts = {}) {
  return (req, res, next) => {
    const incoming = Number(req.headers['content-length']) || 0;
    if (!freeSpaceFor(incoming)) return res.status(507).json({ error: 'Not enough free disk space on the server for this upload.' });
    if (MAX_UPLOAD_BYTES > 0 && uploadsDirBytes() + incoming > MAX_UPLOAD_BYTES)
      return res.status(413).json({ error: 'Server storage quota reached — free space or raise MAX_UPLOAD_BYTES_GB.' });
    if (opts.maxPerTrack) {
      const row = db.prepare('SELECT COUNT(*) c FROM revisions WHERE track_id = ? AND is_orig_audio = 0').get(req.params.id);
      if (row && row.c >= opts.maxPerTrack) return res.status(409).json({ error: `This track already has the maximum of ${opts.maxPerTrack} revisions.` });
    }
    next();
  };
}

// ── ffmpeg helpers ───────────────────────────────────────────
// Hard wall-clock ceiling on every ffmpeg/ffprobe child: a malformed or maliciously-crafted media
// input can't hang a job and wedge the serialized media queue for everyone. On timeout execFile
// SIGKILLs the child and errors out, so the existing per-job try/catch + orphan cleanup still fires.
const FFMPEG_TIMEOUT = Math.max(60, Number(process.env.FFMPEG_TIMEOUT_SEC) || 15 * 60) * 1000;
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 512, encoding: 'buffer', timeout: FFMPEG_TIMEOUT, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${err.message} :: ${stderr}`));
      resolve(stdout);
    });
  });
}

const LOSSLESS = new Set(['.wav', '.wave', '.aif', '.aiff', '.flac', '.alac', '.aifc']);

async function transcodeToMp3(input, output) {
  await run('ffmpeg', ['-y', '-i', input, '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', '-ac', '2', output]);
}

async function getDuration(file) {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1', file]);
    return parseFloat(out.toString().trim()) || 0;
  } catch { return 0; }
}

// One full-rate stereo decode produces both:
//   - the waveform (`buckets` bars, max|L|,|R| per bar, 0..1)
//   - a fine-grained sample-peak series in dBFS (max|L|,|R| per `peakIntervalSec` window)
async function computeWaveAndPeaks(file, buckets = 1000, peakIntervalSec = 0.05) {
  const RATE = 44100, CH = 2;
  const fallback = { peaks: [], peakSeries: [], peakInterval: peakIntervalSec };
  let pcm;
  // Decode to a temp file rather than a stdout pipe: piping hits execFile's maxBuffer ceiling
  // (~512 MB ⇒ ~25 min of 44.1k stereo), past which run() rejects and the waveform is silently
  // lost — a real risk for longer video. A temp file lifts that to the Buffer max (~95 min+), then
  // still degrades gracefully. Full rate/stereo is kept so sample-peak metering stays accurate.
  const pcmFile = path.join(UPLOADS_DIR, '.wavtmp-' + crypto.randomUUID() + '.f32');
  try {
    await run('ffmpeg', ['-v', 'error', '-i', file, '-ac', String(CH), '-ar', String(RATE), '-f', 'f32le', pcmFile]);
    pcm = fs.readFileSync(pcmFile);
  } catch (e) {
    console.warn('[wave] decode failed (waveform will be empty):', e.message);
    try { fs.unlinkSync(pcmFile); } catch {}
    return fallback;
  }
  try { fs.unlinkSync(pcmFile); } catch {}
  const frames = Math.floor(pcm.length / 4 / CH);
  if (frames === 0) return fallback;
  const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + frames * CH * 4);
  const f = new Float32Array(ab);

  // single pass: per-window max amplitude across channels
  const win = Math.max(1, Math.round(peakIntervalSec * RATE));
  const nWin = Math.ceil(frames / win);
  const winMax = new Float64Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const s = w * win, e = Math.min(frames, (w + 1) * win);
    let mx = 0;
    for (let i = s; i < e; i++) {
      const l = f[i * 2], r = f[i * 2 + 1];
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      const m = al > ar ? al : ar;
      if (m > mx) mx = m;
    }
    winMax[w] = mx;
  }
  const peakSeries = new Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const mx = winMax[w];
    peakSeries[w] = mx > 0 ? Math.round(Math.max(-90, 20 * Math.log10(mx)) * 10) / 10 : -90;
  }
  // downsample window maxima into the waveform buckets
  const peaks = new Array(buckets).fill(0);
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * nWin / buckets), e = Math.max(s + 1, Math.floor((b + 1) * nWin / buckets));
    let mx = 0;
    for (let w = s; w < Math.min(nWin, e); w++) if (winMax[w] > mx) mx = winMax[w];
    peaks[b] = Math.min(1, Math.round(mx * 1000) / 1000);
  }
  return { peaks, peakSeries, peakInterval: peakIntervalSec };
}

// EBU R128 / BS.1770 loudness via ffmpeg ebur128:
//   - integrated LUFS, loudness range, true peak (from the Summary)
//   - short-term LUFS time-series (from per-frame metadata), resampled to a uniform grid
function analyzeLoudness(file) {
  return new Promise((resolve) => {
    const metaFile = path.join(os.tmpdir(), 'eb-' + crypto.randomUUID() + '.txt');
    const empty = { i: null, lra: null, tp: null, st_interval: 0, st: [] };
    execFile('ffmpeg',
      ['-hide_banner', '-nostats', '-i', file, '-af',
       `ebur128=peak=true:metadata=1,ametadata=mode=print:file=${metaFile}`, '-f', 'null', '-'],
      { maxBuffer: 1024 * 1024 * 64, encoding: 'buffer', timeout: FFMPEG_TIMEOUT, killSignal: 'SIGKILL' },
      (err, _so, se) => {
        const stderr = se ? se.toString() : '';
        let txt = ''; try { txt = fs.readFileSync(metaFile, 'utf8'); } catch {}
        try { fs.unlinkSync(metaFile); } catch {}
        if (err && !txt) return resolve(empty);

        // per-frame short-term loudness
        const pts = []; let curT = null;
        for (const line of txt.split('\n')) {
          let m;
          if ((m = line.match(/pts_time:([\d.]+)/))) curT = parseFloat(m[1]);
          else if (curT != null && (m = line.match(/lavfi\.r128\.S=(-?[\d.]+|-?inf)/))) {
            pts.push([curT, /inf/.test(m[1]) ? -70 : parseFloat(m[1])]); curT = null;
          }
        }
        // resample to a uniform 0.25s grid (short-term uses a 3s window, so this is plenty)
        const interval = 0.25;
        const dur = pts.length ? pts[pts.length - 1][0] : 0;
        const st = []; let j = 0;
        for (let tg = 0; tg <= dur + 1e-9; tg += interval) {
          while (j + 1 < pts.length && pts[j + 1][0] <= tg) j++;
          st.push(pts.length ? Math.round(pts[j][1] * 10) / 10 : -70);
        }
        const pick = re => { const m = stderr.match(re); return m ? parseFloat(m[1]) : null; };
        resolve({
          i: pick(/I:\s*(-?[\d.]+)\s*LUFS/),
          lra: pick(/LRA:\s*(-?[\d.]+)\s*LU/),
          tp: pick(/Peak:\s*(-?[\d.]+)\s*dBFS/),
          st_interval: interval, st
        });
      });
  });
}

// ── Video helpers (Phase 6) ──────────────────────────────────
// Probe the first video stream for dimensions + frame rate. Returns null when there is no video
// stream (⇒ the upload isn't a video), so the caller can reject it as a 400.
async function ffprobeVideo(file) {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', file]);
    const s = (JSON.parse(out.toString()).streams || [])[0];
    if (!s || !s.width || !s.height) return null;
    let fps = null;
    if (s.r_frame_rate && s.r_frame_rate.includes('/')) {
      const [n, d] = s.r_frame_rate.split('/').map(Number);
      if (d) fps = Math.round((n / d) * 1000) / 1000;
    }
    return { width: s.width, height: s.height, fps };
  } catch { return null; }
}

// HQ web-playable preview: H.264 high-profile + AAC, faststart (moov atom up front so it streams
// before fully downloaded), pixel format yuv420p for universal browser decode, width capped at
// 1920 (height auto-even via -2) to bound file size. Mirrors the audio pipeline's "always make a
// browser-friendly preview that streams; keep the original only for download" rule.
async function transcodeToVideoPreview(input, output) {
  await run('ffmpeg', ['-y', '-i', input, '-vf', "scale='min(1920,iw)':-2",
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output]);
}

// Mid-tier 480p proxy: the steady remote tier and the instant-scrub source. NO audio track (-an) —
// the picture is always muted (audio comes from the separate mix revision), so the embedded track was
// ~25% dead weight on the wire. Short GOP (-g 60 ≈ 2s) so seeks resolve fast. faststart streams it.
async function transcodeToVideoProxy(input, output) {
  await run('ffmpeg', ['-y', '-i', input, '-an', '-vf', 'scale=-2:480',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', '60', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output]);
}

// Ultra-low 240p tier: tiny + low-bitrate (capped) so it starts playing almost immediately and fully
// downloads fast even on a slow non-LAN link — after which the whole timeline is locally seekable
// (instant scrub anywhere). No audio (muted picture), short GOP, faststart. The frontend shows this
// first and climbs to proxy→HQ as they buffer in (Phase 6d adaptive tiers).
async function transcodeToVideoMicro(input, output) {
  await run('ffmpeg', ['-y', '-i', input, '-an', '-vf', 'scale=-2:240',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '33', '-maxrate', '220k', '-bufsize', '440k',
    '-g', '60', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
}

// Album art (album projects only): downscale to fit 1024×1024 (keep aspect) and re-encode to a quality
// jpg. The transcode also VALIDATES the upload is a real image — ffmpeg fails on junk, which the route
// turns into a 400. Returns the stored jpg name; cleans up its files and rethrows (.status=400) on error.
async function processArtImage(file) {
  const inputPath = file.path;
  const storedName = crypto.randomUUID() + '.jpg';
  const outPath = path.join(UPLOADS_DIR, storedName);
  try {
    await run('ffmpeg', ['-y', '-i', inputPath,
      '-vf', "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease",
      '-frames:v', '1', '-q:v', '3', outPath]);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) { const e = new Error('Image could not be processed'); e.status = 400; throw e; }
    try { fs.unlinkSync(inputPath); } catch {}
    return storedName;
  } catch (e) {
    for (const p of [inputPath, outPath]) { if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} } }
    if (!e.status) e.status = 400;
    throw e;
  }
}

// Does this media file have at least one audio stream?
async function ffprobeHasAudio(file) {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
    return out.toString().trim().length > 0;
  } catch { return false; }
}

// Track-video pipeline (audio-post model): the picture is a TRACK asset. Produces the HQ preview +
// 480p proxy (fresh UUIDs — never derived from the input name, since an .mp4 input would otherwise
// collide and ffmpeg refuses in-place edit), probes fps/width/height/duration, and — when the video
// carries audio — extracts it to a 320k mp3 with its own waveform/loudness so it can seed the
// "Original audio" revision. Keeps the original video only when keep_lossless is on. Returns
// { video:{...}, origAudio:{...}|null }. Cleans up its own temp/output files on failure; throws
// .status=400 for a non-video.
async function processTrackVideo(file, keepLossless = false) {
  const inputPath = file.path;
  const storedName = crypto.randomUUID() + '.mp4';        // HQ preview (the picture, streamed muted)
  const proxyName = crypto.randomUUID() + '_proxy.mp4';   // 480p mid tier / instant-scrub proxy
  const microName = crypto.randomUUID() + '_micro.mp4';   // 240p ultra-low tier (slow-link instant start)
  const finalPath = path.join(UPLOADS_DIR, storedName);
  const proxyPath = path.join(UPLOADS_DIR, proxyName);
  const microPath = path.join(UPLOADS_DIR, microName);
  let audioName = null, audioPath = null;
  try {
    const v = await ffprobeVideo(inputPath);
    if (!v) { const e = new Error('File does not appear to be a video'); e.status = 400; throw e; }
    await transcodeToVideoPreview(inputPath, finalPath);
    await transcodeToVideoProxy(inputPath, proxyPath);
    await transcodeToVideoMicro(inputPath, microPath);
    const duration = await getDuration(finalPath);
    if (!duration) { const e = new Error('Video has no decodable duration'); e.status = 400; throw e; }
    let origAudio = null;
    if (await ffprobeHasAudio(inputPath)) {
      audioName = crypto.randomUUID() + '.mp3';
      audioPath = path.join(UPLOADS_DIR, audioName);
      await transcodeToMp3(inputPath, audioPath);
      const [wave, loud] = await Promise.all([computeWaveAndPeaks(inputPath), analyzeLoudness(inputPath)]);
      origAudio = { storedName: audioName, size: fs.statSync(audioPath).size, duration: await getDuration(audioPath), wave, loud };
    }
    let originalStoredName = null;
    if (keepLossless) originalStoredName = file.filename;          // keep original video for download
    else { try { fs.unlinkSync(inputPath); } catch {} }
    return {
      video: { storedName, proxyName, microName, originalName: file.originalname, originalStoredName,
               fps: v.fps, width: v.width, height: v.height, duration, size: fs.statSync(finalPath).size },
      origAudio
    };
  } catch (e) {
    for (const p of [inputPath, finalPath, proxyPath, microPath, audioPath]) {
      if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }
    throw e;
  }
}

// Shared upload→preview pipeline (used by both revision-create and revision-replace).
// Transcodes anything non-mp3 to a 320k MP3 preview, probes duration, then computes the
// waveform/peaks on the PREVIEW (so the drawn waveform matches playback) and loudness/true-peak
// on the ORIGINAL upload before it's discarded (ROADMAP 1.2 — re-encoding shifts inter-sample
// peaks / integrated loudness). Returns the stored preview + all analysis, or throws. Cleans up
// its own temp files on failure; the caller owns nothing until this resolves. A decode/no-audio
// failure throws an Error with `.status = 400` so the route can surface it as a client error.
async function processAudioUpload(file, keepLossless = false) {
  const inputPath = file.path;
  const ext = path.extname(file.originalname).toLowerCase();
  let storedName, finalPath;
  try {
    if (ext === '.mp3') {
      storedName = file.filename;
      finalPath = inputPath;
    } else {
      storedName = path.basename(file.filename, ext) + '.mp3';
      finalPath = path.join(UPLOADS_DIR, storedName);
      await transcodeToMp3(inputPath, finalPath);
    }
    const duration = await getDuration(finalPath);
    if (!duration) {  // ffprobe found no decodable audio (e.g. a non-audio file mislabeled .mp3)
      const err = new Error('File does not appear to be decodable audio'); err.status = 400; throw err;
    }
    // mp3 upload is its own source → use the preview; otherwise analyze the still-present original.
    const loudnessSrc = (finalPath !== inputPath && fs.existsSync(inputPath)) ? inputPath : finalPath;
    const [wave, loud] = await Promise.all([
      computeWaveAndPeaks(finalPath), analyzeLoudness(loudnessSrc)
    ]);
    // The original was analyzed. Keep it for lossless download when keep_lossless is on (only
    // meaningful for a transcoded upload — an mp3 upload IS its own original, so nothing to keep);
    // otherwise discard it (the preview is the kept asset). It already lives at uploads/<uuid><ext>.
    let originalStoredName = null;
    if (finalPath !== inputPath && fs.existsSync(inputPath)) {
      if (keepLossless) originalStoredName = file.filename;
      else { try { fs.unlinkSync(inputPath); } catch {} }
    }
    const size = fs.statSync(finalPath).size;
    // Strip the real-case extension (ext is lowercased, so basename(name, ext) would miss e.g. ".WAV").
    const origName = path.basename(file.originalname, path.extname(file.originalname)) + '.mp3';
    // media_kind/video_* are NULL for audio so create/replace can share one INSERT/UPDATE with video.
    return { storedName, finalPath, duration, size, origName, wave, loud, originalStoredName,
             mediaKind: 'audio', videoProxyName: null, fps: null, width: null, height: null };
  } catch (e) {
    if (fs.existsSync(inputPath)) { try { fs.unlinkSync(inputPath); } catch {} }
    if (finalPath && finalPath !== inputPath && fs.existsSync(finalPath)) { try { fs.unlinkSync(finalPath); } catch {} }
    throw e;
  }
}

// Unlink a stored file by name (preview or kept original), tolerant of NULL/missing.
function unlinkStored(name) {
  if (!name) return;
  const p = path.join(UPLOADS_DIR, name);
  if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
}

// Serialized background media queue. Uploads respond immediately, then their transcode/analysis runs
// here ONE AT A TIME — so an upload is never held in a multi-minute HTTP request (proxy/browser
// timeouts), and concurrent uploads can't spike CPU/RAM with parallel ffmpeg + big f32le buffers.
// Each job owns its own try/catch (a thrown job never breaks the chain). Order is FIFO.
let mediaChain = Promise.resolve();
function enqueueMedia(job) { mediaChain = mediaChain.then(() => job().catch(e => console.error('[media-queue] job failed:', e && e.message))); }

// ── Express setup ────────────────────────────────────────────
app.set('trust proxy', TRUST_PROXY);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Security headers (defense-in-depth) ──────────────────────
// The frontend is a single inline <script>+<style> with no build step, so a nonce/strict CSP isn't
// feasible; 'unsafe-inline' stays for script/style (XSS is held off by the audited output-escaping),
// while CSP still kills framing, plugins, <base> hijacking and any cross-origin resource loads.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
    "img-src 'self' data:; media-src 'self' blob:; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Disable powerful browser features the app never uses (fullscreen/autoplay keep their defaults, so
  // the video stage still works). Opt-in HSTS only when actually served over HTTPS.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), payment=(), magnetometer=(), gyroscope=(), accelerometer=(), midi=()');
  if (ENABLE_HSTS && req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// Sessions persist in SQLite (the existing tracker.db, via the same better-sqlite3 handle) rather
// than the default in-memory store, so a server restart/reboot no longer logs everyone out — it
// matters for a self-hosted box that reboots (Phase 5). The store creates its own `sessions` table
// (no FKs, additive) and sweeps expired rows every 15 min. Switching off MemoryStore logs everyone
// out exactly once, on the deploy that introduces it; sessions survive every restart after that.
// Session signing key. NEVER fall back to a hardcoded constant — in a public repo that's a known key
// anyone could use to forge a signed cookie. If SESSION_SECRET isn't in the environment (a deploy that
// bypassed install.sh / docker-compose), generate a random one ONCE and persist it in the DB so it's
// stable across restarts (sessions survive) yet never a value an attacker can know in advance.
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get()?.value;
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(s);
  }
  console.warn('[session] SESSION_SECRET not set — using a generated per-install secret persisted in the DB. Set SESSION_SECRET in .env for production.');
  return s;
}
app.use(session({
  store: new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }
  }),
  secret: resolveSessionSecret(),
  resave: false,
  saveUninitialized: false,
  // secure:'auto' (with trust proxy set) marks the cookie Secure ONLY when the connection is HTTPS —
  // ON behind nginx in prod (X-Forwarded-Proto: https), OFF for the bare-HTTP LAN/standalone posture
  // where a Secure cookie would never be set and would break login.
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: 'auto', sameSite: 'lax' }
}));

// ── CSRF defense-in-depth ────────────────────────────────────
// sameSite=lax already blocks the classic cross-site cookie ride; this is a second layer. A state-
// changing request must EITHER carry the SPA's custom header (a cross-site page can't set it — the
// browser forces a CORS preflight we never approve) OR come from a same-host Origin/Referer. Requests
// with no Origin/Referer at all (non-browser API clients) are allowed so we don't break them.
function csrfOk(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  if (req.get('x-alsegno-csrf')) return true;
  const src = req.get('origin') || req.get('referer');
  if (!src) return true;
  let host; try { host = new URL(src).hostname; } catch { return true; }
  const xfh = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().split(':')[0];
  return host === req.hostname || (xfh && host === xfh) || host === String(req.headers.host || '').split(':')[0];
}
app.use((req, res, next) => { if (!csrfOk(req)) return res.status(403).json({ error: 'Cross-site request blocked' }); next(); });

// Re-read the user from the DB on every authenticated request. The session cookie is only a
// login-time snapshot; without this, deactivation and role changes wouldn't take effect until the
// user happened to log out (a deactivated admin could keep minting admins). Returns the fresh row
// or null when the account is gone or deactivated, and refreshes req.session.user in place so all
// downstream checks use the live role. One cheap indexed lookup (better-sqlite3 is synchronous) —
// mirrors how project membership (isMember) is already enforced live on each request.
function liveUser(req) {
  if (!req.session.user) return null;
  const u = db.prepare('SELECT username, role, active, display_name, pw_changed_at FROM users WHERE username = ?').get(req.session.user.username);
  if (!u || u.active === 0) return null;
  // Sessions minted before the password last changed stop authenticating — a password change or admin
  // reset thus invalidates every OTHER live session for the account at once.
  if (u.pw_changed_at && (req.session.authAt || 0) < u.pw_changed_at) return null;
  req.session.user = sessionUser(u);
  return u;
}
function requireAuth(req, res, next) {
  if (!liveUser(req)) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  const u = liveUser(req);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Project access control (Phase 3b) ────────────────────────
// Resolve the owning project of a resource from whatever id a route carries. NULL ⇒ the resource
// (or its project link) doesn't exist → the middleware answers 404 before any access decision.
const projectExists      = id => !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
const projectIdForTrack    = id => db.prepare('SELECT project_id FROM tracks WHERE id = ?').get(id)?.project_id ?? null;
const projectIdForRevision = id => db.prepare('SELECT t.project_id AS p FROM revisions r JOIN tracks t ON r.track_id = t.id WHERE r.id = ?').get(id)?.p ?? null;
const projectIdForComment  = id => db.prepare('SELECT t.project_id AS p FROM comments c JOIN tracks t ON c.track_id = t.id WHERE c.id = ?').get(id)?.p ?? null;
const projectIdForAudio    = name => {
  // A media name is either a revision's audio (stored_name) or a track's video (HQ or proxy).
  const r = db.prepare('SELECT t.project_id AS p FROM revisions r JOIN tracks t ON r.track_id = t.id WHERE r.stored_name = ?').get(name);
  if (r) return r.p ?? null;
  const t = db.prepare('SELECT project_id AS p FROM tracks WHERE video_stored_name = ? OR video_proxy_name = ? OR video_micro_name = ?').get(name, name, name);
  return t ? (t.p ?? null) : null;
};
const projectIdForArt = name => db.prepare('SELECT id AS p FROM projects WHERE art_stored_name = ?').get(name)?.p ?? null;
const isMember = (username, projectId) => !!db.prepare('SELECT 1 FROM project_users WHERE project_id = ? AND username = ?').get(projectId, username);

// Resolvers (req → projectId|null). Param ids are the project itself; others look the project up.
// intId guards against a non-numeric :id (NaN would otherwise reach a SQLite bind) → clean 404.
const intId    = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const pParam   = req => { const id = intId(req.params.id); return id != null && projectExists(id) ? id : null; };
const pTrack   = req => { const id = intId(req.params.id); return id == null ? null : projectIdForTrack(id); };
const pRev     = req => { const id = intId(req.params.id); return id == null ? null : projectIdForRevision(id); };
const pComment = req => { const id = intId(req.params.id); return id == null ? null : projectIdForComment(id); };
const pAudio   = req => projectIdForAudio(req.params.name);

// admin → any project; otherwise must be a member of THIS project. Stashes req.projectId.
// A non-member gets the SAME 404 as a nonexistent project (not 403) so project ids can't be probed
// for existence by a logged-in member of some other project.
function requireProjectAccess(resolve) {
  return (req, res, next) => {
    const u = liveUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    const pid = resolve(req);
    if (pid == null) return res.status(404).json({ error: 'Not found' });
    if (u.role !== 'admin' && !isMember(u.username, pid)) return res.status(404).json({ error: 'Not found' });
    req.projectId = pid;
    next();
  };
}
// admin → any project; otherwise must be an ENGINEER who is a member of THIS project. A non-member is
// hidden behind a 404 (existence oracle, as above); a member who is a CLIENT gets a 403 (they already
// know the project exists). Gates everything that creates/edits tracks, revisions, files.
function requireProjectEngineer(resolve) {
  return (req, res, next) => {
    const u = liveUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    const pid = resolve(req);
    if (pid == null) return res.status(404).json({ error: 'Not found' });
    if (u.role !== 'admin') {
      if (!isMember(u.username, pid)) return res.status(404).json({ error: 'Not found' });
      if (u.role !== 'engineer') return res.status(403).json({ error: 'Engineer access required' });
    }
    req.projectId = pid;
    next();
  };
}

// ── Realtime (SSE, Phase 4) ──────────────────────────────────
// Server→client only; the player is NEVER driven from events. Each open EventSource is one entry
// keyed by username; access is re-evaluated LIVE on every broadcast (mirroring liveUser) so a
// mid-stream deactivation, role change, or membership revoke takes effect at once — the long-lived
// connection itself is only an authentication snapshot, never a standing authorization.
const sseClients = new Set(); // { res, username }
const isActiveUser = username => { const u = db.prepare('SELECT active FROM users WHERE username = ?').get(username); return !!u && u.active === 1; };
function canSeeProject(username, projectId) {
  const u = db.prepare('SELECT role, active FROM users WHERE username = ?').get(username);
  if (!u || u.active === 0) return false;
  return u.role === 'admin' || isMember(username, projectId);
}
function sseSend(client, type, data) {
  try { client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
  catch { sseClients.delete(client); }
}
// A change INSIDE one project (tracks/revisions/doneness/comments/title) → only its active members
// (+admins). projectId === null is a no-op so callers needn't guard.
function broadcastChange(projectId) {
  if (projectId == null) return;
  for (const c of [...sseClients]) if (canSeeProject(c.username, projectId)) sseSend(c, 'change', { projectId });
}
// The SET of projects, who can see them, or a user's role/active changed → every active client
// refetches its own server-scoped list and re-validates whatever it has open.
function broadcastProjects() {
  for (const c of [...sseClients]) if (isActiveUser(c.username)) sseSend(c, 'projects', {});
}
// Admin-only: the "update available" badge (Cluster E). Mirrors the live role re-check of the
// broadcasts above — a demoted/deactivated admin on a still-open stream stops receiving it.
function broadcastUpdate(status) {
  for (const c of [...sseClients]) {
    const u = db.prepare('SELECT role, active FROM users WHERE username = ?').get(c.username);
    if (u && u.active === 1 && u.role === 'admin') sseSend(c, 'update', status);
  }
}

// ── Auth routes ──────────────────────────────────────────────
// Tiny in-memory throttle (no dependency) for the unauthenticated, password/token-guessing endpoints.
// Sliding per-IP window: caps how fast an attacker can brute-force credentials/invite tokens or pile
// up CPU-bound scrypt work. Generous enough that no legitimate user hits it. Pruned to stay bounded.
const loginHits = new Map(); // ip → { count, first }
const RL_WINDOW_MS = 15 * 60 * 1000, RL_MAX = 40;
function rateLimited(req, res) {
  // When we DON'T trust a proxy, key on the unspoofable socket peer — otherwise a directly-exposed
  // instance lets a client set X-Forwarded-For and rotate the key to slip the throttle. Behind a
  // trusted proxy, req.ip is the real client IP the proxy reports.
  const ip = (TRUST_PROXY ? req.ip : req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  if (loginHits.size > 5000) loginHits.clear();           // crude cap against IP-rotation memory growth
  let e = loginHits.get(ip);
  if (!e || now - e.first > RL_WINDOW_MS) { e = { count: 0, first: now }; loginHits.set(ip, e); }
  e.count++;
  if (e.count > RL_MAX) { res.status(429).json({ error: 'Too many attempts — please wait a few minutes.' }); return true; }
  return false;
}

// Per-ACCOUNT lockout — complements the per-IP limiter, which a distributed/IP-rotating attacker can
// sidestep. After MAX_USER_FAILS bad attempts for one username inside the window, that account is told
// to wait. Generous by default so real users never trip it; MAX_USER_FAILS=0 disables it. Only existing
// usernames are tracked (set at the call sites), and it's best-effort in-memory (cleared if it grows).
const failByUser = new Map();
const USER_FAIL_MAX = Math.max(0, Number(process.env.MAX_USER_FAILS) || 20); // 0 = disabled
function userLockoutHit(username) {
  if (!USER_FAIL_MAX) return false;
  const e = failByUser.get(username);
  if (!e) return false;
  if (Date.now() - e.first > RL_WINDOW_MS) { failByUser.delete(username); return false; }
  return e.count >= USER_FAIL_MAX;
}
function recordUserFail(username) {
  if (!USER_FAIL_MAX) return;
  if (failByUser.size > 5000) failByUser.clear();
  let e = failByUser.get(username);
  if (!e || Date.now() - e.first > RL_WINDOW_MS) { e = { count: 0, first: Date.now() }; failByUser.set(username, e); }
  e.count++;
}
function clearUserFail(username) { failByUser.delete(username); }

app.post('/api/login', async (req, res) => {
  if (rateLimited(req, res)) return;
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.active === 0) return res.status(403).json({ error: 'Account deactivated' });
  if (userLockoutHit(username)) return res.status(429).json({ error: 'Too many attempts for this account — please wait a few minutes.' });

  if (!user.pw_hash) {
    // First login for this account (new user OR admin password reset). Deactivated accounts are
    // refused above, before any TOFU can fire.
    if (user.first_login_token) {
      // HARD-REFUSE: a pending account with an outstanding invite can ONLY set its password via
      // that one-time token. Missing/wrong token → 401, and we do NOT set a password (so the
      // standard URL can't be hammered into claiming the account). Setting pw_hash and clearing
      // the token happen in ONE atomic UPDATE ⇒ single-use.
      if (!tokenEquals(req.body.token, user.first_login_token)) {
        recordUserFail(username);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      { const pe = passwordPolicyError(password); if (pe) return res.status(400).json({ error: pe }); }
      db.prepare('UPDATE users SET pw_hash = ?, first_login_token = NULL, pw_changed_at = ? WHERE username = ?').run(await hashPassword(password), Date.now(), username);
    } else {
      // Grandfathered: NULL pw_hash AND NULL token — no invite was ever minted (the bootstrap
      // admin, or a pre-migration pending user). Token not required; plain TOFU as before.
      { const pe = passwordPolicyError(password); if (pe) return res.status(400).json({ error: pe }); }
      db.prepare('UPDATE users SET pw_hash = ?, pw_changed_at = ? WHERE username = ?').run(await hashPassword(password), Date.now(), username);
    }
  } else if (!(await verifyPassword(password, user.pw_hash))) {
    recordUserFail(username);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Regenerate the session id now that the privilege level changed (login) — without this the
  // pre-auth session id is reused, leaving the door open to session fixation.
  req.session.regenerate(err => {
    if (err) { console.error('[login] session regenerate failed:', err.message); return res.status(500).json({ error: 'Login failed' }); }
    req.session.user = sessionUser(user);
    req.session.authAt = Date.now();
    clearUserFail(username);
    req.session.save(err2 => {
      if (err2) { console.error('[login] session save failed:', err2.message); return res.status(500).json({ error: 'Login failed' }); }
      res.json(req.session.user);
    });
  });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

// Resolve an invite token → the pending username it belongs to, so the login form can prefill +
// lock the username. PUBLIC (used pre-login) but reveals ONLY a username, and ONLY for a valid,
// unconsumed token on an active account. Anything else — invalid, already used, deactivated, or
// nonexistent — returns a UNIFORM 404 so it can't be used as a username/existence oracle.
// POST (not GET) so the token rides in the request BODY, never the URL path — nginx logs the path
// ($request) but not the body, so the still-unconsumed token never lands in access.log. (The link
// itself keeps the token in the URL hash, which browsers don't send to the server at all.)
app.post('/api/invite', (req, res) => {
  if (rateLimited(req, res)) return;
  const token = String(req.body.token || '');
  const u = token
    ? db.prepare('SELECT username FROM users WHERE first_login_token = ? AND pw_hash IS NULL AND active = 1').get(token)
    : null;
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ username: u.username });
});

app.get('/api/me', (req, res) => {
  if (!liveUser(req)) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// Server-sent events: one stream per browser tab. requireAuth proves the session at connect; the
// per-broadcast access check above re-proves it live thereafter. X-Accel-Buffering:no makes nginx
// stream this response unbuffered (no nginx config change needed); a :heartbeat comment every ~25s
// keeps the proxy/browser from idling the connection shut. EventSource auto-reconnects on drop.
const SSE_MAX_PER_USER = Math.max(1, Number(process.env.SSE_MAX_PER_USER) || 12);
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 5000\n\n'); // client waits 5s before reconnecting after a drop
  const username = req.session.user.username;
  // Cap concurrent SSE streams per user (many tabs or a reconnect storm) — evict the oldest over cap.
  const mine = [...sseClients].filter(c => c.username === username);
  for (let i = 0; i <= mine.length - SSE_MAX_PER_USER; i++) { try { mine[i].res.end(); } catch {} sseClients.delete(mine[i]); }
  const client = { res, username };
  sseClients.add(client);
  const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { clearInterval(hb); sseClients.delete(client); } }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(client); });
});

// ── Bootstrap + project payloads (Phase 3b) ──────────────────
// Full per-project payload: the project's tracks, each with revisions, the caller's unseen flag,
// and comment counts — the exact shape the player/studio render (scoped to one project_id).
function projectTracks(username, projectId) {
  const tracks = db.prepare('SELECT * FROM tracks WHERE project_id = ? ORDER BY sort_order, id').all(projectId);
  const revStmt = db.prepare(`SELECT id, rev_number, stored_name, original_name, duration, notes, uploaded_by, size, created_at,
                                     lufs_i, lufs_lra, true_peak, (original_stored_name IS NOT NULL) AS has_lossless, is_orig_audio
                              FROM revisions WHERE track_id = ? ORDER BY is_orig_audio DESC, rev_number`);
  const seenStmt = db.prepare('SELECT last_seen_rev FROM seen WHERE username = ? AND track_id = ?');
  // Badges count top-level notes only — replies (parent_id NOT NULL) don't inflate the count.
  const cCount = db.prepare('SELECT COUNT(*) v FROM comments WHERE track_id = ? AND parent_id IS NULL AND deleted_at IS NULL');
  const cOpen = db.prepare('SELECT COUNT(*) v FROM comments WHERE track_id = ? AND resolved = 0 AND parent_id IS NULL AND deleted_at IS NULL');
  for (const t of tracks) {
    t.revisions = revStmt.all(t.id);
    const latest = t.revisions[t.revisions.length - 1];
    t.latest_revision_id = latest ? latest.id : null;
    const seen = seenStmt.get(username, t.id);
    t.unseen = latest ? (!seen || seen.last_seen_rev < latest.id) : false;
    t.comment_count = cCount.get(t.id).v;
    t.open_comment_count = cOpen.get(t.id).v;
    t.has_video = !!t.video_stored_name;
    delete t.video_original_stored_name;   // internal kept-original filename — not needed client-side
  }
  return tracks;
}

// The projects a user may see: admin → all; everyone else → only the ones they're a member of.
function visibleProjects(user) {
  return user.role === 'admin'
    ? db.prepare('SELECT * FROM projects ORDER BY created_at, id').all()
    : db.prepare(`SELECT p.* FROM projects p JOIN project_users pu ON pu.project_id = p.id
                  WHERE pu.username = ? ORDER BY p.created_at, p.id`).all(user.username);
}

// Lightweight summaries for the project-list landing (counts + a per-user unseen/progress glance).
function projectSummaries(user) {
  const projects = visibleProjects(user);
  const tCount = db.prepare('SELECT COUNT(*) v FROM tracks WHERE project_id = ?');
  const openC = db.prepare(`SELECT COUNT(*) v FROM comments c JOIN tracks t ON c.track_id = t.id
                            WHERE t.project_id = ? AND c.parent_id IS NULL AND c.resolved = 0 AND c.deleted_at IS NULL`);
  const avgDone = db.prepare('SELECT COALESCE(AVG(doneness), 0) v FROM tracks WHERE project_id = ?');
  // unseen: tracks in the project whose latest revision this user hasn't marked seen. "Latest" MUST
  // match projectTracks/the frontend exactly — the last row of ORDER BY is_orig_audio DESC, rev_number,
  // i.e. the highest-rev_number mix (or the Original-audio rev when that's all there is). Using MAX(id)
  // instead diverges when a re-uploaded video gives the Original-audio rev a higher id than the mixes,
  // which can leave the project-list NEW badge permanently stuck (the seen id can never reach MAX(id)).
  const latestRev = `(SELECT id FROM revisions WHERE track_id = t.id ORDER BY is_orig_audio ASC, rev_number DESC LIMIT 1)`;
  const unseen = db.prepare(`
    SELECT COUNT(*) v FROM tracks t
    WHERE t.project_id = ?
      AND ${latestRev} IS NOT NULL
      AND COALESCE((SELECT last_seen_rev FROM seen WHERE username = ? AND track_id = t.id), 0)
          < ${latestRev}`);
  return projects.map(p => ({
    id: p.id, type: p.type, media_type: p.media_type, title: p.title, owner: p.owner,
    art_stored_name: p.art_stored_name || null,
    track_count: tCount.get(p.id).v,
    open_comment_count: openC.get(p.id).v,
    avg_doneness: Math.round(avgDone.get(p.id).v),
    unseen_count: unseen.get(p.id, user.username).v,
  }));
}

// Landing call: the user + the projects they can open + their last-opened project (if still
// reachable). The list is the source of truth for the picker; opening one fetches its payload.
app.get('/api/bootstrap', requireAuth, (req, res) => {
  const user = req.session.user;
  const projects = projectSummaries(user);
  const last = db.prepare('SELECT last_project_id FROM users WHERE username = ?').get(user.username)?.last_project_id ?? null;
  // Only echo the hint if it's still in the accessible set — never auto-open a revoked/deleted project.
  const last_project_id = (last != null && projects.some(p => p.id === last)) ? last : null;
  res.json({ user, projects, last_project_id,
    null_test_visible: settingOn('null_test_visible', false),
    keep_lossless: settingOn('keep_lossless', false),
    video_enabled: settingOn('video_enabled', false),
    // Admin-only: the cached self-update status (cheap settings-row read — no git shell-out here;
    // the live GET /api/update/status and the background poller refresh the cache).
    update: user.role === 'admin' ? getUpdateCache() : null });
});

// Full payload for one project. requireProjectAccess proves membership/admin BEFORE we record it
// as the user's last-opened project — so the stored hint can only ever point at a reachable project.
app.get('/api/projects/:id', requireProjectAccess(pParam), (req, res) => {
  const p = db.prepare('SELECT id, type, media_type, title, art_stored_name, owner, created_at FROM projects WHERE id = ?').get(req.projectId);
  db.prepare('UPDATE users SET last_project_id = ? WHERE username = ?').run(p.id, req.session.user.username);
  res.json({ user: req.session.user, project: p, tracks: projectTracks(req.session.user.username, p.id) });
});

// ── Project management (admin) ───────────────────────────────
// Admin sees every project with its members + a track count, for the admin page.
app.get('/api/admin/projects', requireAdmin, (req, res) => {
  const projects = db.prepare('SELECT id, type, media_type, title, owner, created_at FROM projects ORDER BY created_at, id').all();
  const memStmt = db.prepare('SELECT username FROM project_users WHERE project_id = ? ORDER BY username');
  const tCount = db.prepare('SELECT COUNT(*) v FROM tracks WHERE project_id = ?');
  for (const p of projects) { p.users = memStmt.all(p.id).map(r => r.username); p.track_count = tCount.get(p.id).v; }
  res.json(projects);
});

app.post('/api/projects', requireAdmin, (req, res) => {
  const type = req.body.type === 'song' ? 'song' : 'album';
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title required' });
  // Video projects only when the instance has video enabled; otherwise silently fall back to audio.
  const mediaType = (req.body.media_type === 'video' && settingOn('video_enabled', false)) ? 'video' : 'audio';
  const members = Array.isArray(req.body.users) ? req.body.users.map(u => String(u).trim().toLowerCase()).filter(Boolean) : [];
  const owner = req.session.user.username;
  const id = db.transaction(() => {
    const pid = db.prepare("INSERT INTO projects (type, media_type, title, owner) VALUES (?, ?, ?, ?)").run(type, mediaType, title, owner).lastInsertRowid;
    const grant = db.prepare('INSERT OR IGNORE INTO project_users (project_id, username) VALUES (?, ?)');
    grant.run(pid, owner); // creator keeps access even if later demoted from admin
    for (const u of members) if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u)) grant.run(pid, u);
    // A song auto-creates its single track (titled like the song); a 2nd track later promotes it.
    if (type === 'song') db.prepare('INSERT INTO tracks (title, sort_order, project_id) VALUES (?, 1, ?)').run(title, pid);
    return pid;
  })();
  broadcastProjects(); // a new project (and any granted members) appears in everyone's scoped list
  res.json({ id });
});

app.put('/api/projects/:id', requireAdmin, (req, res) => {
  if (!projectExists(Number(req.params.id))) return res.status(404).json({ error: 'Not found' });
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare("UPDATE projects SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, req.params.id);
  broadcastChange(Number(req.params.id)); // members viewing it get the new title
  broadcastProjects();                    // and it re-titles in everyone's list
  res.json({ ok: true });
});

// Album art (album projects only). Engineer/admin on the project. Stored as a downscaled jpg; the
// previous art file is unlinked. Both broadcasts so the open album AND everyone's project-list thumb update.
app.post('/api/projects/:id/art', requireProjectEngineer(pParam), artUpload, async (req, res) => {
  const pid = req.projectId;
  const proj = db.prepare('SELECT type, art_stored_name FROM projects WHERE id = ?').get(pid);
  if (!req.file) return res.status(400).json({ error: 'An image file is required' });
  if (proj.type !== 'album') { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'Album art is for albums only' }); }
  let storedName;
  try { storedName = await processArtImage(req.file); }
  catch (e) { console.error('[art] processing failed:', e.message); return res.status(e.status || 400).json({ error: e.status ? e.message : 'Could not process image' }); }
  db.prepare("UPDATE projects SET art_stored_name = ?, updated_at = datetime('now') WHERE id = ?").run(storedName, pid);
  unlinkStored(proj.art_stored_name);
  broadcastChange(pid); broadcastProjects();
  res.json({ art_stored_name: storedName });
});

app.delete('/api/projects/:id/art', requireProjectEngineer(pParam), (req, res) => {
  const pid = req.projectId;
  const old = db.prepare('SELECT art_stored_name FROM projects WHERE id = ?').get(pid)?.art_stored_name;
  db.prepare("UPDATE projects SET art_stored_name = NULL, updated_at = datetime('now') WHERE id = ?").run(pid);
  unlinkStored(old);
  broadcastChange(pid); broadcastProjects();
  res.json({ ok: true });
});

// Delete a project: tracks have no FK to projects (Phase 3a), so cascade them explicitly
// (tracks→revisions→comments DO cascade); project_users cascades via its own FK. Unlink files after.
app.delete('/api/projects/:id', requireAdmin, (req, res) => {
  const pid = Number(req.params.id);
  if (!projectExists(pid)) return res.status(404).json({ error: 'Not found' });
  const revs = db.prepare('SELECT r.stored_name, r.original_stored_name FROM revisions r JOIN tracks t ON r.track_id = t.id WHERE t.project_id = ?').all(pid);
  const vids = db.prepare('SELECT video_stored_name, video_proxy_name, video_micro_name, video_original_stored_name FROM tracks WHERE project_id = ?').all(pid);
  const art = db.prepare('SELECT art_stored_name FROM projects WHERE id = ?').get(pid)?.art_stored_name;
  db.transaction(() => {
    db.prepare('DELETE FROM seen WHERE track_id IN (SELECT id FROM tracks WHERE project_id = ?)').run(pid);
    db.prepare('DELETE FROM tracks WHERE project_id = ?').run(pid);   // cascades revisions + comments
    db.prepare('UPDATE users SET last_project_id = NULL WHERE last_project_id = ?').run(pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);          // cascades project_users
  })();
  for (const r of revs) { unlinkStored(r.stored_name); unlinkStored(r.original_stored_name); }
  for (const v of vids) { unlinkStored(v.video_stored_name); unlinkStored(v.video_proxy_name); unlinkStored(v.video_micro_name); unlinkStored(v.video_original_stored_name); }
  unlinkStored(art);
  // Membership is gone now, so anyone who had it open re-validates via the projects ping → 404 → list.
  broadcastProjects();
  res.json({ ok: true });
});

app.post('/api/projects/:id/users', requireAdmin, (req, res) => {
  const pid = Number(req.params.id);
  if (!projectExists(pid)) return res.status(404).json({ error: 'Not found' });
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'No such user' });
  db.prepare('INSERT OR IGNORE INTO project_users (project_id, username) VALUES (?, ?)').run(pid, username);
  broadcastProjects(); // the newly-granted member sees the project appear in their list
  res.json({ ok: true });
});

app.delete('/api/projects/:id/users/:username', requireAdmin, (req, res) => {
  const pid = Number(req.params.id);
  const username = String(req.params.username || '').trim().toLowerCase();
  db.prepare('DELETE FROM project_users WHERE project_id = ? AND username = ?').run(pid, username);
  // Drop the stale auto-open hint for the revoked user (bootstrap also filters, but keep it clean).
  db.prepare('UPDATE users SET last_project_id = NULL WHERE username = ? AND last_project_id = ?').run(username, pid);
  broadcastProjects(); // the revoked user re-validates → dropped from the project; list updates
  res.json({ ok: true });
});

// ── Track routes ─────────────────────────────────────────────
// Create a track in a project. Song→album promotion: adding a 2nd track to an AUDIO 'song' flips it
// to 'album' and (re)titles it from album_title — so albums get a heading + ordering they lacked.
// Video projects are exempt: they hold multiple videos as 'song'-type tracks and never become albums.
app.post('/api/projects/:id/tracks', requireProjectEngineer(pParam), (req, res) => {
  const pid = req.projectId;
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Track title required' });
  const proj = db.prepare('SELECT type, media_type FROM projects WHERE id = ?').get(pid);
  const existing = db.prepare('SELECT COUNT(*) v FROM tracks WHERE project_id = ?').get(pid).v;
  let promoted = false;
  if (proj.type === 'song' && existing >= 1 && proj.media_type !== 'video') {
    const albumTitle = String(req.body.album_title || '').trim().slice(0, 200);
    if (!albumTitle) return res.status(400).json({ error: 'Album title required to add a second track' });
    db.prepare("UPDATE projects SET type = 'album', title = ?, updated_at = datetime('now') WHERE id = ?").run(albumTitle, pid);
    promoted = true;
  }
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) v FROM tracks WHERE project_id = ?').get(pid).v;
  const r = db.prepare('INSERT INTO tracks (title, sort_order, project_id) VALUES (?, ?, ?)').run(title, max + 1, pid);
  broadcastChange(pid);
  if (promoted) broadcastProjects(); // song→album: the type/title badge changes in the project list too
  res.json({ id: r.lastInsertRowid, promoted });
});

app.put('/api/tracks/:id', requireProjectEngineer(pTrack), (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare("UPDATE tracks SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, req.params.id);
  broadcastChange(req.projectId);
  res.json({ ok: true });
});

app.delete('/api/tracks/:id', requireProjectEngineer(pTrack), (req, res) => {
  const revs = db.prepare('SELECT stored_name, original_stored_name FROM revisions WHERE track_id = ?').all(req.params.id);
  const trk = db.prepare('SELECT video_stored_name, video_proxy_name, video_micro_name, video_original_stored_name FROM tracks WHERE id = ?').get(req.params.id);
  // `seen` has no FK to tracks (PK is username+track_id), so it does NOT cascade — delete it explicitly
  // (mirroring the project-delete path) or every viewer's seen row for this track leaks forever.
  db.transaction(() => {
    db.prepare('DELETE FROM seen WHERE track_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tracks WHERE id = ?').run(req.params.id); // cascades revisions/comments
  })();
  for (const r of revs) { unlinkStored(r.stored_name); unlinkStored(r.original_stored_name); }
  if (trk) { unlinkStored(trk.video_stored_name); unlinkStored(trk.video_proxy_name); unlinkStored(trk.video_micro_name); unlinkStored(trk.video_original_stored_name); }
  broadcastChange(req.projectId);
  res.json({ ok: true });
});

// Reorder tracks within a project — shared state, any project member may do it. The UPDATE is
// constrained to this project so a forged id list can't move another project's tracks.
// Reorder uses requireProjectAccess (any member, INCLUDING clients) by design — like doneness below,
// track order is shared review state, not a structural engineer-only edit. Documented, not locked
// down (product decision; see the role note in README).
app.put('/api/projects/:id/reorder', requireProjectAccess(pParam), (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  const stmt = db.prepare('UPDATE tracks SET sort_order = ? WHERE id = ? AND project_id = ?');
  db.transaction(ids => ids.forEach((id, i) => stmt.run(i + 1, id, req.projectId)))(order.map(Number));
  broadcastChange(req.projectId);
  res.json({ ok: true });
});

// Doneness — any project member may set it (clients drive it; shared state).
app.put('/api/tracks/:id/doneness', requireProjectAccess(pTrack), (req, res) => {
  let d = parseInt(req.body.doneness, 10);
  if (isNaN(d)) return res.status(400).json({ error: 'doneness required' });
  d = Math.max(0, Math.min(100, d));
  let doneRev = null;
  if (d >= 100) {
    if (req.body.revision_id) {
      const rid = Number(req.body.revision_id);
      const rv = db.prepare('SELECT track_id FROM revisions WHERE id = ?').get(rid);
      if (!rv || rv.track_id !== Number(req.params.id)) return res.status(400).json({ error: 'Revision is not on this track' });
      doneRev = rid;
    } else {
      doneRev = db.prepare('SELECT MAX(id) v FROM revisions WHERE track_id = ?').get(req.params.id).v;
    }
  }
  db.prepare("UPDATE tracks SET doneness = ?, done_revision_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(d, doneRev, req.params.id);
  broadcastChange(req.projectId);
  res.json({ ok: true, doneness: d, done_revision_id: doneRev });
});

// Mark a track's latest revision as seen by the current user
app.post('/api/tracks/:id/seen', requireProjectAccess(pTrack), (req, res) => {
  const rev = Number(req.body.revision_id) || 0;
  // Only accept a revision id that actually belongs to THIS track. The upsert below takes MAX, so a
  // bogus large id would be sticky and permanently suppress the user's own NEW badges for the track.
  if (rev > 0) {
    const rv = db.prepare('SELECT track_id FROM revisions WHERE id = ?').get(rev);
    if (!rv || rv.track_id !== Number(req.params.id)) return res.status(400).json({ error: 'Revision is not on this track' });
  }
  db.prepare(`INSERT INTO seen (username, track_id, last_seen_rev) VALUES (?, ?, ?)
              ON CONFLICT(username, track_id) DO UPDATE SET last_seen_rev = MAX(last_seen_rev, excluded.last_seen_rev)`)
    .run(req.session.user.username, req.params.id, rev);
  res.json({ ok: true });
});

// ── Track video (the "picture") ──────────────────────────────
// Set or replace a video track's picture — a TRACK-level asset (audio-post model), not a revision.
// Stores the HQ preview + 480p proxy + fps/dims/duration on the track and, when the video carries
// audio, seeds/refreshes the "Original audio" revision (is_orig_audio=1, rev_number 0) IN PLACE so its
// id (and any comments) survive a re-upload. The track's audio-mix revisions are untouched.
app.post('/api/tracks/:id/video', requireProjectEngineer(pTrack), uploadGuard(), upload.single('file'), (req, res) => {
  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) { if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} } return res.status(404).json({ error: 'Track not found' }); }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const proj = db.prepare('SELECT media_type FROM projects WHERE id = ?').get(req.projectId);
  if (!proj || proj.media_type !== 'video') { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'Not a video project' }); }

  // Respond immediately; the (multi-minute) transcode runs in the background queue, and the picture
  // appears via the SSE 'change' when it's done. Studio shows "processing…" via video_processing.
  const file = req.file, projectId = req.projectId, username = req.session.user.username, trackId = track.id;
  const keepLossless = wantKeepLossless(req);
  db.prepare('UPDATE tracks SET video_processing = 1 WHERE id = ?').run(trackId);
  broadcastChange(projectId);
  res.json({ ok: true, processing: true });

  enqueueMedia(async () => {
    let a;
    try { a = await processTrackVideo(file, keepLossless); }
    catch (e) { console.error('[track-video] processing failed:', e.message); db.prepare('UPDATE tracks SET video_processing = 0 WHERE id = ?').run(trackId); broadcastChange(projectId); return; }
    // Re-read current state INSIDE the job (FIFO queue ⇒ a prior video upload to this track may have
    // run first; the track could also have been deleted while queued).
    const cur = db.prepare('SELECT video_stored_name, video_proxy_name, video_micro_name, video_original_stored_name FROM tracks WHERE id = ?').get(trackId);
    if (!cur) { unlinkStored(a.video.storedName); unlinkStored(a.video.proxyName); unlinkStored(a.video.microName); unlinkStored(a.video.originalStoredName); if (a.origAudio) unlinkStored(a.origAudio.storedName); return; }
    const old = { v: cur.video_stored_name, p: cur.video_proxy_name, mi: cur.video_micro_name, ov: cur.video_original_stored_name };
    const oldOrig = db.prepare('SELECT id, stored_name, original_stored_name FROM revisions WHERE track_id = ? AND is_orig_audio = 1').get(trackId);
    const oa = a.origAudio;
    const oaName = oa ? (path.basename(a.video.originalName, path.extname(a.video.originalName)) || 'audio') + '.mp3' : null;
    try {
      db.transaction(() => {
        db.prepare(`UPDATE tracks SET video_stored_name=?, video_proxy_name=?, video_micro_name=?, video_original_name=?, video_original_stored_name=?,
                      video_fps=?, video_width=?, video_height=?, video_duration=?, video_uploaded_by=?, video_updated_at=datetime('now'),
                      video_processing=0, updated_at=datetime('now') WHERE id=?`)
          .run(a.video.storedName, a.video.proxyName, a.video.microName, a.video.originalName, a.video.originalStoredName,
               a.video.fps, a.video.width, a.video.height, a.video.duration, username, trackId);
        if (oa && oldOrig) {
          db.prepare(`UPDATE revisions SET stored_name=?, original_name=?, original_stored_name=NULL, mime_type='audio/mpeg',
                        size=?, duration=?, peaks=?, lufs_i=?, lufs_lra=?, true_peak=?, st_interval=?, st_series=?, peak_interval=?, peak_series=? WHERE id=?`)
            .run(oa.storedName, oaName, oa.size, oa.duration, JSON.stringify(oa.wave.peaks),
                 oa.loud.i, oa.loud.lra, oa.loud.tp, oa.loud.st_interval, JSON.stringify(oa.loud.st),
                 oa.wave.peakInterval, JSON.stringify(oa.wave.peakSeries), oldOrig.id);
          db.prepare('UPDATE comments SET ts = ? WHERE revision_id = ? AND ts > ?').run(oa.duration, oldOrig.id, oa.duration);
        } else if (oa) {
          db.prepare(`INSERT INTO revisions (track_id, rev_number, stored_name, original_name, mime_type, size, duration, peaks, notes, uploaded_by,
                        lufs_i, lufs_lra, true_peak, st_interval, st_series, peak_interval, peak_series, is_orig_audio)
                      VALUES (?, 0, ?, ?, 'audio/mpeg', ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
            .run(trackId, oa.storedName, oaName, oa.size, oa.duration, JSON.stringify(oa.wave.peaks), username,
                 oa.loud.i, oa.loud.lra, oa.loud.tp, oa.loud.st_interval, JSON.stringify(oa.loud.st),
                 oa.wave.peakInterval, JSON.stringify(oa.wave.peakSeries));
        } else if (oldOrig) {
          // New picture is SILENT but a stale Original-audio rev (from the old picture) exists — drop it.
          db.prepare('UPDATE comments SET revision_id = NULL, ts = NULL WHERE revision_id = ?').run(oldOrig.id);
          db.prepare('UPDATE tracks SET done_revision_id = NULL WHERE done_revision_id = ?').run(oldOrig.id);
          db.prepare('DELETE FROM revisions WHERE id = ?').run(oldOrig.id);
        }
      })();
    } catch (e) {
      unlinkStored(a.video.storedName); unlinkStored(a.video.proxyName); unlinkStored(a.video.microName); unlinkStored(a.video.originalStoredName);
      if (oa) unlinkStored(oa.storedName);
      db.prepare('UPDATE tracks SET video_processing = 0 WHERE id = ?').run(trackId);
      console.error('[track-video] db failed:', e.message);
      broadcastChange(projectId);
      return;
    }
    // committed — unlink the replaced video files + the Original-audio's old files
    if (old.v && old.v !== a.video.storedName) unlinkStored(old.v);
    if (old.p && old.p !== a.video.proxyName) unlinkStored(old.p);
    if (old.mi && old.mi !== a.video.microName) unlinkStored(old.mi);
    if (old.ov && old.ov !== a.video.originalStoredName) unlinkStored(old.ov);
    if (oldOrig) { if (!oa || oldOrig.stored_name !== oa.storedName) unlinkStored(oldOrig.stored_name); unlinkStored(oldOrig.original_stored_name); }
    broadcastChange(projectId);
  });
});

// ── Revision routes ──────────────────────────────────────────
app.post('/api/tracks/:id/revisions', requireProjectEngineer(pTrack), uploadGuard({ maxPerTrack: MAX_REVISIONS_PER_TRACK }), upload.single('file'), (req, res) => {
  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) { if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} } return res.status(404).json({ error: 'Track not found' }); }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // A revision is always AUDIO — for a video project it's an audio MIX that plays in sync with the
  // track's video. Respond immediately and transcode/analyze in the background queue (long files
  // can't be held in one HTTP request); Studio shows "processing…" via mix_processing.
  const file = req.file, projectId = req.projectId, username = req.session.user.username, trackId = track.id;
  const notes = String(req.body.notes || '').slice(0, 10000), keepLossless = wantKeepLossless(req);
  db.prepare('UPDATE tracks SET mix_processing = mix_processing + 1 WHERE id = ?').run(trackId);
  broadcastChange(projectId);
  res.json({ ok: true, processing: true });

  enqueueMedia(async () => {
    const done = () => { db.prepare('UPDATE tracks SET mix_processing = MAX(0, mix_processing - 1) WHERE id = ?').run(trackId); broadcastChange(projectId); };
    let a;
    try { a = await processAudioUpload(file, keepLossless); }
    catch (e) { console.error('[mix] processing failed:', e.message); done(); return; }
    if (!db.prepare('SELECT id FROM tracks WHERE id = ?').get(trackId)) {   // track deleted while queued
      unlinkStored(a.storedName); unlinkStored(a.originalStoredName); done(); return;
    }
    try {
      const nextRev = (db.prepare('SELECT COALESCE(MAX(rev_number), 0) v FROM revisions WHERE track_id = ?').get(trackId).v) + 1;
      db.prepare(`INSERT INTO revisions
        (track_id, rev_number, stored_name, original_name, original_stored_name, mime_type, size, duration, peaks, notes, uploaded_by,
         lufs_i, lufs_lra, true_peak, st_interval, st_series, peak_interval, peak_series)
        VALUES (?, ?, ?, ?, ?, 'audio/mpeg', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(trackId, nextRev, a.storedName, a.origName, a.originalStoredName, a.size, a.duration, JSON.stringify(a.wave.peaks),
             notes, username, a.loud.i, a.loud.lra, a.loud.tp, a.loud.st_interval, JSON.stringify(a.loud.st),
             a.wave.peakInterval, JSON.stringify(a.wave.peakSeries));
      db.prepare("UPDATE tracks SET updated_at = datetime('now') WHERE id = ?").run(trackId);
    } catch (e) {
      unlinkStored(a.storedName); unlinkStored(a.originalStoredName);
      console.error('[mix] db insert failed:', e.message);
    }
    done();
  });
});

// Replace the audio of an EXISTING revision in place — keeps id/rev_number/notes and the whole
// comment thread; only the audio + its analysis change. Same pipeline as create (ROADMAP 2.1).
app.post('/api/revisions/:id/replace', requireProjectEngineer(pRev), uploadGuard(), upload.single('file'), (req, res) => {
  const rev = db.prepare('SELECT * FROM revisions WHERE id = ?').get(req.params.id);
  if (!rev) { if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} } return res.status(404).json({ error: 'Revision not found' }); }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // The "Original audio" revision is derived from the track's video — it can't be replaced directly;
  // replace the video instead (POST /api/tracks/:id/video regenerates it).
  if (rev.is_orig_audio) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'The original audio is set by the video — replace the video to change it.' }); }

  // Like create: respond immediately and run the (multi-minute) transcode/analysis in the serialized
  // background queue — never hold it in one HTTP request (proxy/browser timeout → a "failed" replace
  // that actually succeeded), and never run a second ffmpeg + big f32le decode in parallel with a
  // queued job. Studio shows "processing…" via mix_processing; the new audio lands via SSE 'change'.
  const file = req.file, projectId = req.projectId, revId = rev.id, trackId = rev.track_id;
  const keepLossless = wantKeepLossless(req);
  db.prepare('UPDATE tracks SET mix_processing = mix_processing + 1 WHERE id = ?').run(trackId);
  broadcastChange(projectId);
  res.json({ ok: true, processing: true });

  enqueueMedia(async () => {
    const done = () => { db.prepare('UPDATE tracks SET mix_processing = MAX(0, mix_processing - 1) WHERE id = ?').run(trackId); broadcastChange(projectId); };
    let a;
    try { a = await processAudioUpload(file, keepLossless); }
    catch (e) { console.error('[replace] processing failed:', e.message); done(); return; }
    // Re-read the revision INSIDE the job — it may have been deleted (or itself replaced again, or
    // turned into an orig-audio rev) while queued. If so, the freshly-stored files belong to nothing.
    const cur = db.prepare('SELECT id, stored_name, original_stored_name FROM revisions WHERE id = ? AND is_orig_audio = 0').get(revId);
    if (!cur) { unlinkStored(a.storedName); unlinkStored(a.originalStoredName); done(); return; }
    try {
      // New stored_name UUID so the browser can't Range-serve the old bytes under the same URL.
      db.transaction(() => {
        db.prepare(`UPDATE revisions SET stored_name = ?, original_name = ?, original_stored_name = ?, mime_type = 'audio/mpeg',
                      size = ?, duration = ?, peaks = ?, lufs_i = ?, lufs_lra = ?, true_peak = ?,
                      st_interval = ?, st_series = ?, peak_interval = ?, peak_series = ? WHERE id = ?`)
          .run(a.storedName, a.origName, a.originalStoredName, a.size, a.duration, JSON.stringify(a.wave.peaks),
               a.loud.i, a.loud.lra, a.loud.tp, a.loud.st_interval, JSON.stringify(a.loud.st),
               a.wave.peakInterval, JSON.stringify(a.wave.peakSeries), revId);
        // A shorter replacement can leave pins past the end — clamp them onto the new waveform.
        db.prepare('UPDATE comments SET ts = ? WHERE revision_id = ? AND ts > ?').run(a.duration, revId, a.duration);
        db.prepare("UPDATE tracks SET updated_at = datetime('now') WHERE id = ?").run(trackId);
      })();
    } catch (e) {
      // DB update failed — the freshly-stored files are orphaned; remove them, leave the row intact.
      unlinkStored(a.storedName); unlinkStored(a.originalStoredName);
      console.error('[replace] db update failed:', e.message);
      done(); return;
    }
    // Committed — the old preview + old kept original (read live at job time) are no longer referenced.
    if (cur.stored_name !== a.storedName) unlinkStored(cur.stored_name);
    if (cur.original_stored_name && cur.original_stored_name !== a.originalStoredName) unlinkStored(cur.original_stored_name);
    done(); // analysis/waveform/stored_name changed — broadcast so listeners refetch metadata
  });
});

app.put('/api/revisions/:id', requireProjectEngineer(pRev), (req, res) => {
  db.prepare('UPDATE revisions SET notes = ? WHERE id = ?').run(String(req.body.notes || '').slice(0, 10000), req.params.id);
  broadcastChange(req.projectId);
  res.json({ ok: true });
});

app.delete('/api/revisions/:id', requireProjectEngineer(pRev), (req, res) => {
  const rev = db.prepare('SELECT * FROM revisions WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Not found' });
  if (rev.is_orig_audio) return res.status(400).json({ error: 'The original audio is set by the video — replace the video to change it.' });
  // Orphan, don't cascade: comments are shown track-wide, so keep the discussion thread
  // intact — just drop the now-meaningless pin offset and any "done" pointer to this rev.
  // (The comments FK is ON DELETE CASCADE; this UPDATE clears it before the row is removed.)
  const tx = db.transaction(() => {
    db.prepare('UPDATE comments SET revision_id = NULL, ts = NULL WHERE revision_id = ?').run(req.params.id);
    db.prepare('UPDATE tracks SET done_revision_id = NULL WHERE done_revision_id = ?').run(req.params.id);
    db.prepare('DELETE FROM revisions WHERE id = ?').run(req.params.id);
  });
  tx();
  unlinkStored(rev.stored_name); unlinkStored(rev.original_stored_name);
  broadcastChange(req.projectId);
  res.json({ ok: true });
});

app.get('/api/revisions/:id/peaks', requireProjectAccess(pRev), (req, res) => {
  const rev = db.prepare('SELECT duration, peaks, lufs_i, lufs_lra, true_peak, st_interval, st_series, peak_interval, peak_series FROM revisions WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Not found' });
  res.json({
    duration: rev.duration,
    peaks: JSON.parse(rev.peaks || '[]'),
    peakInterval: rev.peak_interval || 0,
    peakSeries: JSON.parse(rev.peak_series || '[]'),
    loudness: { i: rev.lufs_i, lra: rev.lufs_lra, tp: rev.true_peak, interval: rev.st_interval || 0, st: JSON.parse(rev.st_series || '[]') }
  });
});

// ── Media streaming / download ───────────────────────────────
// Serves a revision's audio (mp3) OR a track's video (HQ mp4 / 480p proxy) by stored name. Access is
// already checked by pAudio (matches both). Content type is set by extension so <audio>/<video> +
// Range seeking work for either; ?dl=1 downloads the kept original (lossless audio / original video)
// when present, else the served preview.
const MEDIA_TYPES = { '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mov': 'video/mp4' };
app.get('/api/audio/:name', requireProjectAccess(pAudio), (req, res) => {
  const name = req.params.name;
  const p = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  const rev = db.prepare('SELECT * FROM revisions WHERE stored_name = ?').get(name);
  const trk = rev ? null : db.prepare('SELECT * FROM tracks WHERE video_stored_name = ? OR video_proxy_name = ? OR video_micro_name = ?').get(name, name, name);
  if (!rev && !trk) return res.status(404).json({ error: 'Not found' });
  if (req.query.dl) {
    const orig = rev ? rev.original_stored_name : trk.video_original_stored_name;     // kept lossless/original
    const baseName = rev ? rev.original_name : (trk.video_original_name || name);
    const op = orig && path.join(UPLOADS_DIR, orig);
    if (op && fs.existsSync(op)) {
      const dn = path.basename(baseName, path.extname(baseName)) + path.extname(orig);
      return res.download(op, dn);
    }
    return res.download(p, baseName);
  }
  res.type(MEDIA_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream');
  res.sendFile(p); // `send` adds Accept-Ranges + handles Range requests for seeking
});

// Album art image, gated to project members (any role). Always a downscaled jpg (processArtImage).
app.get('/api/art/:name', requireProjectAccess(req => projectIdForArt(req.params.name)), (req, res) => {
  const p = path.join(UPLOADS_DIR, req.params.name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.type('image/jpeg');
  res.sendFile(p);
});

// ── Comments ─────────────────────────────────────────────────
app.get('/api/tracks/:id/comments', requireProjectAccess(pTrack), (req, res) => {
  // Soft-deleted notes are hidden from everyone — except an admin when show_deleted_notes is on,
  // who sees them (greyed, with who/when) so deletions are reviewable/recoverable. The fragment is
  // a fixed literal, not user input.
  const seeDeleted = settingOn('show_deleted_notes', false) && req.session.user.role === 'admin';
  res.json(db.prepare(`SELECT c.*, r.rev_number FROM comments c
                       LEFT JOIN revisions r ON c.revision_id = r.id
                       WHERE c.track_id = ? ${seeDeleted ? '' : 'AND c.deleted_at IS NULL'} ORDER BY c.created_at`).all(req.params.id));
});

app.post('/api/tracks/:id/comments', requireProjectAccess(pTrack), (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 10000);
  if (!body) return res.status(400).json({ error: 'Comment body required' });
  let ts = (req.body.ts === null || req.body.ts === undefined || req.body.ts === '') ? null : Number(req.body.ts);
  let revisionId = req.body.revision_id ? Number(req.body.revision_id) : null;
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (parentId != null) {
    // Reply: parent must exist, live on this track, and itself be a top-level note (one level deep).
    const parent = db.prepare('SELECT track_id, parent_id, deleted_at FROM comments WHERE id = ?').get(parentId);
    if (!parent || parent.deleted_at != null) return res.status(400).json({ error: 'Parent note not found' });
    if (parent.track_id !== Number(req.params.id)) return res.status(400).json({ error: 'Parent note is on a different track' });
    if (parent.parent_id != null) return res.status(400).json({ error: 'Cannot reply to a reply' });
    ts = null; revisionId = null; // replies are never pinned and never carry a revision
  }
  // A pinned note's revision must belong to THIS track — otherwise a member could smuggle a foreign
  // project's revision id in (leaking its existence/rev_number via the comments GET join) or trip a
  // raw FK-constraint 500. The frontend only ever sends the open track's own revision.
  if (revisionId != null) {
    const rv = db.prepare('SELECT track_id, duration FROM revisions WHERE id = ?').get(revisionId);
    if (!rv || rv.track_id !== Number(req.params.id)) return res.status(400).json({ error: 'Revision is not on this track' });
    // Clamp a pin to [0, duration]: the playhead can't be past the audio, and this keeps a bogus ts
    // (e.g. a hand-crafted huge value) from later driving an unbounded silent-WAV bed in the export.
    if (ts != null && Number.isFinite(ts) && rv.duration > 0) ts = Math.min(Math.max(0, ts), rv.duration);
  }
  if (ts != null && !Number.isFinite(ts)) ts = null; // NaN/Infinity ts → unpinned (defensive)
  const r = db.prepare('INSERT INTO comments (track_id, revision_id, author, ts, body, parent_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.params.id, revisionId, req.session.user.username, ts, body, parentId);
  broadcastChange(req.projectId);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/comments/:id', requireProjectAccess(pComment), (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.deleted_at != null) return res.status(400).json({ error: 'Note was deleted' });
  // Validate EVERY requested mutation up front, before applying ANY — otherwise a request carrying both
  // {resolved} and {body} from a non-author would commit the resolve and then 403 on the body, leaving
  // a partial write behind an error response (and skipping the SSE broadcast).
  const wantResolved = req.body.resolved !== undefined;
  const wantBody = req.body.body !== undefined;
  if (wantResolved && c.parent_id != null) return res.status(400).json({ error: 'Replies cannot be resolved' });
  let newBody = null;
  if (wantBody) {
    if (c.author !== req.session.user.username && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your note' });
    }
    newBody = String(req.body.body).trim().slice(0, 10000);
    if (!newBody) return res.status(400).json({ error: 'Comment body required' });
  }
  let mutated = false;
  db.transaction(() => {
    if (wantResolved) {
      db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(req.body.resolved ? 1 : 0, req.params.id);
      mutated = true;
    }
    // Only stamp edited_at when the text actually changes (avoids a no-op edit marking the note).
    if (wantBody && newBody !== c.body) {
      db.prepare("UPDATE comments SET body = ?, edited_at = datetime('now') WHERE id = ?").run(newBody, req.params.id);
      mutated = true;
    }
  })();
  if (mutated) broadcastChange(req.projectId); // a no-op edit/resolve shouldn't wake everyone's clients
  res.json({ ok: true });
});

app.delete('/api/comments/:id', requireProjectAccess(pComment), (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.author !== req.session.user.username && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your comment' });
  }
  // Soft-delete (Phase 3d): stamp deleted_at instead of removing the row, so notes are recoverable
  // and admins can review them (show_deleted_notes). A note's replies are soft-deleted with it; for
  // a reply the children UPDATE is a harmless no-op. Already-deleted rows are left as-is (idempotent).
  const changed = db.transaction(() => {
    db.prepare("UPDATE comments SET deleted_at = datetime('now') WHERE parent_id = ? AND deleted_at IS NULL").run(req.params.id);
    return db.prepare("UPDATE comments SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").run(req.params.id).changes;
  })();
  if (changed) broadcastChange(req.projectId); // idempotent re-delete of an already-gone note: nothing to announce
  res.json({ ok: true });
});

// ── Notes export for DAWs / video editors (Cluster C) ────────────────────────
// Turn a track's timed notes (top-level pinned notes that carry a `ts`) into marker/locator files
// that import into common audio + video tools. Everything here is pure Node (Buffer math + the
// built-in zlib for the zip) — no ffmpeg, no new dependency. Untimed notes (general notes + replies)
// are NEVER faked to 0:00; they go into the zip's README so nothing is silently dropped.
//
// Timing: a marker sits at the note's `ts` (seconds into the revision). Audacity / Reaper / WAV-cue /
// MIDI are second/sample/tick-exact and ignore fps. EDL + Avid are frame-based, so they take an fps
// (default 30, or a video track's real fps) and place markers at a +1h record-TC offset (Resolve and
// Avid default their sequences to 01:00:00:00).

// ASCII-only, single-line marker text (tabs/newlines/control chars → space; non-ASCII → '?').
function asciiLine(s) {
  return String(s == null ? '' : s)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\s+/g, ' ').trim();
}
const fmtSeconds = (s, dp = 6) => Math.max(0, s).toFixed(dp);
const markerText = m => asciiLine(`${m.author}: ${m.body}`);   // author-prefixed (Avid keeps author in its own column)
// Record timecode (HH:MM:SS:FF) for a marker at real-time offset `ts` seconds, on a timeline that
// starts at 01:00:00:00. Frames are counted at the TRUE fps — so a fractional rate (23.976, 29.97,
// 59.94) lands on the correct frame instead of drifting ~0.1% — then formatted NON-DROP at the
// nominal integer rate (29.97→30, 23.976→24). Import onto a non-drop timeline; drop-frame TC for a
// 29.97/59.94 DF timeline isn't emitted (can be added if needed). `extraFrames` makes the +1 out-TC.
function recTimecode(ts, fps, extraFrames = 0) {
  const nominal = Math.max(1, Math.round(fps));
  const idx = nominal * 3600 + Math.max(0, Math.round(ts * fps)) + extraFrames; // 01:00:00:00 start, in frames
  const ff = idx % nominal;
  const secs = Math.floor(idx / nominal);
  const ss = secs % 60;
  const mins = Math.floor(secs / 60);
  const mm = mins % 60;
  const hh = Math.floor(mins / 60) % 24;
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}

// CRC-32 (IEEE) for zip entries.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// Minimal ZIP archive, DEFLATE via built-in zlib (still "no new dependency"; deflate collapses the
// silent WAV bed to ~nothing, which a stored zip could not). files: [{ name, data:Buffer }].
function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  const dosTime = 0, dosDate = 0x21;     // fixed 1980-01-01 → byte-for-byte reproducible
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'ascii');
    const crc = crc32(f.data);
    const comp = zlib.deflateRawSync(f.data, { level: 6 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10); cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

// Silent PCM WAV (mono / 16-bit / 44.1k) carrying cue points + adtl/labl names — the marker WAV that
// FL Studio (Edison), Cubase/Nuendo and Reaper read. Sample offsets are exact at 44100 Hz.
const MAX_WAV_SECONDS = 30 * 60; // hard cap on the silent bed (~158 MB) so a pathological note ts
                                 // can't drive an unbounded Buffer.alloc. Covers any realistic track
                                 // (notes are clamped to the revision duration on create); a marker
                                 // past the cap still gets an exact cue offset, just a shorter bed.
function makeCueWav(markers) {
  const sampleRate = 44100, blockAlign = 2;
  const maxTs = markers.reduce((m, k) => Math.max(m, k.ts), 0);
  const frames = Math.max(1, Math.min(Math.ceil((maxTs + 0.5) * sampleRate), MAX_WAV_SECONDS * sampleRate));
  const data = Buffer.alloc(frames * blockAlign); // zero-filled = silence (length is even)

  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8); fmt.writeUInt16LE(blockAlign, 12); fmt.writeUInt16LE(16, 14);

  const cue = Buffer.alloc(4 + markers.length * 24);
  cue.writeUInt32LE(markers.length, 0);
  markers.forEach((k, i) => {
    // dwPosition / dwSampleOffset are unsigned 32-bit (≈27h of headroom @44.1k). Clamp so a
    // pathological ts can't overflow writeUInt32LE (which would throw); real markers are exact.
    const o = 4 + i * 24, pos = Math.min(Math.max(0, Math.round(k.ts * sampleRate)), 0xffffffff);
    cue.writeUInt32LE(i + 1, o); cue.writeUInt32LE(pos, o + 4); cue.write('data', o + 8, 'ascii');
    cue.writeUInt32LE(0, o + 12); cue.writeUInt32LE(0, o + 16); cue.writeUInt32LE(pos, o + 20);
  });

  const labls = markers.map((k, i) => {
    const txt = Buffer.from(markerText(k) + '\0', 'ascii');
    const body = Buffer.concat([Buffer.alloc(4), txt]); body.writeUInt32LE(i + 1, 0);
    const pad = body.length % 2;                    // chunk data padded to even (pad byte not counted in size)
    const sub = Buffer.alloc(8 + body.length + pad);
    sub.write('labl', 0, 'ascii'); sub.writeUInt32LE(body.length, 4); body.copy(sub, 8);
    return sub;
  });
  const adtl = Buffer.concat([Buffer.from('adtl', 'ascii'), ...labls]);
  const list = Buffer.concat([Buffer.alloc(8), adtl]); list.write('LIST', 0, 'ascii'); list.writeUInt32LE(adtl.length, 4);

  const chunk = (id, payload) => { const h = Buffer.alloc(8); h.write(id, 0, 'ascii'); h.writeUInt32LE(payload.length, 4); return Buffer.concat([h, payload]); };
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', data), chunk('cue ', cue), list]);
  const riff = Buffer.concat([Buffer.alloc(8), body]); riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4);
  return riff;
}

// Standard MIDI File (format 0): a 120 BPM tempo + one Marker meta (FF 06) per note. At 120 BPM /
// 480 PPQ, a note at t seconds → round(t * 480 * 2) ticks. Pro Tools etc. import these as markers.
function makeMidi(markers) {
  const PPQ = 480;
  const u32be = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
  const vlq = n => { n = Math.max(0, Math.round(n)); const out = [n & 0x7f]; n = Math.floor(n / 128); while (n > 0) { out.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); } return Buffer.from(out); };
  const events = [Buffer.concat([vlq(0), Buffer.from([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20])])]; // 500000 µs/qn
  let prevTick = 0;
  for (const k of [...markers].sort((a, b) => a.ts - b.ts)) {
    const tick = Math.round(k.ts * PPQ * 2), delta = Math.max(0, tick - prevTick); prevTick = tick;
    const txt = Buffer.from(markerText(k), 'ascii');
    events.push(Buffer.concat([vlq(delta), Buffer.from([0xff, 0x06]), vlq(txt.length), txt]));
  }
  events.push(Buffer.concat([vlq(0), Buffer.from([0xff, 0x2f, 0x00])])); // end of track
  const trk = Buffer.concat(events);
  const head = Buffer.alloc(14);
  head.write('MThd', 0, 'ascii'); head.writeUInt32BE(6, 4); head.writeUInt16BE(0, 8); head.writeUInt16BE(1, 10); head.writeUInt16BE(PPQ, 12);
  return Buffer.concat([head, Buffer.from('MTrk', 'ascii'), u32be(trk.length), trk]);
}

function makeAudacity(markers) { // start<TAB>end<TAB>label, decimal seconds; point label start==end
  return markers.length ? markers.map(k => `${fmtSeconds(k.ts)}\t${fmtSeconds(k.ts)}\t${markerText(k)}`).join('\n') + '\n' : '';
}
// Neutralize spreadsheet formula injection: a field starting with = + - @ (or a tab/CR) is treated as
// a live formula by Excel/Sheets/Numbers when the CSV is opened. Reviewer-authored note text is
// untrusted, so prefix those with a single quote before the normal CSV quoting.
const csvField = s => {
  s = asciiLine(s);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function makeReaper(markers) { // Region/Marker Manager CSV — decimal seconds (set ruler to Seconds)
  const rows = ['#,Name,Start,End,Length,Color'];
  markers.forEach((k, i) => rows.push(`M${i + 1},${csvField(markerText(k))},${fmtSeconds(k.ts)},${fmtSeconds(k.ts)},0,`));
  return rows.join('\r\n') + '\r\n';
}
function makeEdl(markers, fps, title) { // CMX3600 + Resolve marker tags; record TC at a +1h start
  const out = [`TITLE: ${asciiLine(title).slice(0, 70) || 'Notes'}`, 'FCM: NON-DROP FRAME'];
  markers.forEach((k, i) => {
    const tin = recTimecode(k.ts, fps), tout = recTimecode(k.ts, fps, 1);
    out.push(`${String(i + 1).padStart(3, '0')}  AX       V     C        ${tin} ${tout} ${tin} ${tout}`);
    out.push(`|C:ResolveColorBlue |M:${asciiLine(markerText(k)).replace(/\|/g, '/')} |D:1`);
  });
  return out.join('\r\n') + '\r\n';
}
function makeAvid(markers, fps) { // Author<TAB>TC<TAB>Track<TAB>Color<TAB>Comment — no header, LF ONLY
  return markers.length
    ? markers.map(k => `${asciiLine(k.author) || 'note'}\t${recTimecode(k.ts, fps)}\tV1\tred\t${asciiLine(k.body)}`).join('\n') + '\n'
    : '';
}
function makeReadme(track, scopeLabel, fps, markers, untimed, replies) {
  const L = [];
  L.push(`Notes export — ${asciiLine(track.title)}`);
  L.push(`Scope: ${scopeLabel}`);
  L.push(`Frame rate: ${fps} fps (used only by resolve.edl and avid-locators.txt)`);
  L.push('');
  L.push('FILES');
  L.push('  audacity-labels.txt  Audacity: File > Import > Labels');
  L.push('  reaper.csv           Reaper: Region/Marker Manager > (right-click) Import — set the ruler to Seconds first');
  L.push('  markers.wav          FL Studio (open in Edison, not the Playlist), Cubase/Nuendo, Reaper — silent WAV with cue markers @44100 Hz');
  L.push('  markers.mid          Pro Tools etc.: import as MIDI; markers land as memory locations (120 BPM, 480 PPQ)');
  L.push('  resolve.edl          DaVinci Resolve: import EDL onto a timeline — markers at +1h record TC');
  L.push('  avid-locators.txt    Avid Media Composer: import locators (sequence start assumed 01:00:00:00)');
  L.push('');
  L.push(`Timed markers placed: ${markers.length}`);
  if (untimed.length || replies.length) {
    L.push('');
    L.push('UNTIMED NOTES (no timestamp — not placed on the timeline):');
    untimed.forEach(n => L.push(`  [general] ${asciiLine(n.author)}: ${asciiLine(n.body)}`));
    replies.forEach(n => L.push(`  [reply] ${asciiLine(n.author)}: ${asciiLine(n.body)}`));
  }
  return L.join('\n') + '\n';
}

const EXPORT_FMTS = {
  audacity: { file: 'audacity-labels.txt', type: 'text/plain; charset=utf-8' },
  reaper:   { file: 'reaper.csv',          type: 'text/csv; charset=utf-8' },
  wav:      { file: 'markers.wav',         type: 'audio/wav' },
  midi:     { file: 'markers.mid',         type: 'audio/midi' },
  edl:      { file: 'resolve.edl',         type: 'text/plain; charset=utf-8' },
  avid:     { file: 'avid-locators.txt',   type: 'text/plain; charset=utf-8' },
};
function genFormat(fmt, markers, fps, title) {
  switch (fmt) {
    case 'audacity': return Buffer.from(makeAudacity(markers), 'utf8');
    case 'reaper':   return Buffer.from(makeReaper(markers), 'utf8');
    case 'wav':      return makeCueWav(markers);
    case 'midi':     return makeMidi(markers);
    case 'edl':      return Buffer.from(makeEdl(markers, fps, title), 'utf8');
    case 'avid':     return Buffer.from(makeAvid(markers, fps), 'utf8');
    default:         return null;
  }
}

app.get('/api/tracks/:id/notes/export', requireProjectAccess(pTrack), (req, res) => {
 try {
  const trackId = Number(req.params.id);
  const track = db.prepare('SELECT id, title, video_fps FROM tracks WHERE id = ?').get(trackId);
  if (!track) return res.status(404).json({ error: 'Not found' });

  const fmt = String(req.query.fmt || '');
  const scope = req.query.scope === 'rev' ? 'rev' : 'track';
  // fps only matters for EDL/Avid. Honor the exact value the user passes (a fractional rate like
  // 29.97/23.976 is fed straight in — recTimecode counts frames at the true rate). Fall back to the
  // uploaded video's own fps, else 30. NOT rounded — rounding would re-introduce the drift.
  let fps = Number(req.query.fps);
  if (!(Number.isFinite(fps) && fps > 0 && fps <= 240)) fps = (track.video_fps > 0) ? track.video_fps : 30;

  let scopeLabel = 'whole track', revId = null;
  if (scope === 'rev') {
    revId = Number(req.query.rev);
    const rv = db.prepare('SELECT rev_number, is_orig_audio FROM revisions WHERE id = ? AND track_id = ?').get(revId, trackId);
    if (!rv) return res.status(400).json({ error: 'Revision is not on this track' });
    scopeLabel = rv.is_orig_audio ? 'Original audio' : ('v' + rv.rev_number);
  }

  // Timed markers = top-level, non-deleted notes that carry a ts (INNER JOIN ⇒ must have a revision).
  let mSql = `SELECT c.ts, c.body, c.author FROM comments c JOIN revisions r ON c.revision_id = r.id
              WHERE c.track_id = ? AND c.parent_id IS NULL AND c.ts IS NOT NULL AND c.deleted_at IS NULL`;
  const mArgs = [trackId];
  if (scope === 'rev') { mSql += ' AND c.revision_id = ?'; mArgs.push(revId); }
  mSql += ' ORDER BY c.ts, c.id';
  const markers = db.prepare(mSql).all(...mArgs);

  const slug = (asciiLine(track.title).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)) || 'track';
  const send = (buf, filename, type) => {
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  };

  if (fmt === 'zip') {
    const untimed = db.prepare(`SELECT body, author FROM comments WHERE track_id = ? AND parent_id IS NULL AND ts IS NULL AND deleted_at IS NULL ORDER BY created_at, id`).all(trackId);
    const replies = db.prepare(`SELECT body, author FROM comments WHERE track_id = ? AND parent_id IS NOT NULL AND deleted_at IS NULL ORDER BY created_at, id`).all(trackId);
    const files = Object.entries(EXPORT_FMTS).map(([f, m]) => ({ name: m.file, data: genFormat(f, markers, fps, track.title) }));
    files.push({ name: 'README.txt', data: Buffer.from(makeReadme(track, scopeLabel, fps, markers, untimed, replies), 'utf8') });
    return send(makeZip(files), `${slug}-notes.zip`, 'application/zip');
  }

  const meta = EXPORT_FMTS[fmt];
  if (!meta) return res.status(400).json({ error: 'Unknown export format' });
  return send(genFormat(fmt, markers, fps, track.title), `${slug}-${meta.file}`, meta.type);
 } catch (e) {
  console.error('[notes export] failed:', e.message);
  if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
 }
});

// ── User management (admin) ──────────────────────────────────
const ROLES = new Set(['admin', 'engineer', 'client']);
const activeAdminCount = () => db.prepare("SELECT COUNT(*) v FROM users WHERE role = 'admin' AND active = 1").get().v;

app.get('/api/admin/users', requireAdmin, (req, res) => {
  // has_password=0 ⇒ TOFU pending (new user or reset). first_login_token (NULL once consumed) lets
  // the admin UI rebuild the one-time invite link for any still-pending user. Admin-only, and the
  // token grants no more than an admin already has (they can reset any account), so it's safe here.
  res.json(db.prepare(`SELECT username, role, display_name, active, created_at,
                              (pw_hash IS NOT NULL) AS has_password, first_login_token
                       FROM users ORDER BY created_at, username`).all());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const role = String(req.body.role || '');
  const display_name = String(req.body.display_name || '').trim().slice(0, 64) || null;
  if (!/^[a-z0-9_.-]{2,32}$/.test(username)) return res.status(400).json({ error: 'Username must be 2–32 chars: a–z 0–9 . _ -' });
  if (!ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'Username already exists' });
  // pw_hash NULL ⇒ TOFU; the invite token is what unlocks that first login. Return it so the admin
  // can hand the new user their one-time link.
  const token = mintInviteToken();
  db.prepare('INSERT INTO users (username, role, display_name, active, first_login_token) VALUES (?, ?, ?, 1, ?)').run(username, role, display_name, token);
  broadcastProjects(); // keep other admins' user tables in sync
  res.json({ ok: true, username, first_login_token: token });
});

app.post('/api/users/:u/reset', requireAdmin, (req, res) => {
  const username = String(req.params.u).trim().toLowerCase();
  const target = db.prepare('SELECT role, active FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Not found' });
  // Don't strand the instance: resetting the last active admin's password (back to TOFU) could lock
  // everyone out of admin if the one-time token is lost. Mirror the demote/deactivate guard.
  if (target.role === 'admin' && target.active === 1 && activeAdminCount() <= 1) {
    return res.status(400).json({ error: 'Cannot reset the last active admin — add another admin first.' });
  }
  // Back to TOFU — and RE-MINT the invite token. A reset account would otherwise be hammerable
  // again (the whole point of the token), so a reset must produce a fresh single-use link.
  const token = mintInviteToken();
  db.prepare('UPDATE users SET pw_hash = NULL, first_login_token = ?, pw_changed_at = ? WHERE username = ?').run(token, Date.now(), username);
  broadcastProjects(); // refresh the "password pending" pill on other admins' user tables
  res.json({ ok: true, username, first_login_token: token });
});

app.put('/api/users/:u', requireAdmin, (req, res) => {
  const username = String(req.params.u).trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) return res.status(404).json({ error: 'Not found' });
  let role = u.role, active = u.active, display_name = u.display_name;
  if (req.body.role !== undefined) { if (!ROLES.has(String(req.body.role))) return res.status(400).json({ error: 'Invalid role' }); role = String(req.body.role); }
  if (req.body.active !== undefined) active = req.body.active ? 1 : 0;
  if (req.body.display_name !== undefined) display_name = String(req.body.display_name || '').trim().slice(0, 64) || null;
  // Never strand the instance: block demoting/deactivating the last active admin.
  const wasActiveAdmin = u.role === 'admin' && u.active === 1;
  const staysActiveAdmin = role === 'admin' && active === 1;
  if (wasActiveAdmin && !staysActiveAdmin && activeAdminCount() <= 1) {
    return res.status(400).json({ error: 'Cannot demote or deactivate the last active admin' });
  }
  db.prepare('UPDATE users SET role = ?, active = ?, display_name = ? WHERE username = ?').run(role, active, display_name, username);
  // If admins edit their own role/name, refresh their live session so the UI stays in sync.
  if (username === req.session.user.username) req.session.user = sessionUser({ username, role, display_name });
  // Role/active changes ripple through access (engineer↔client gating, deactivation) and the admin
  // user table — every client re-validates its scoped view.
  broadcastProjects();
  res.json({ ok: true });
});

// ── Self-service account (any signed-in user edits their OWN profile) ──────────
// Scoped to the caller — no :username param, so a client can only ever touch their own row. The
// admin routes above stay the only way to reach other accounts.
app.put('/api/me', requireAuth, (req, res) => {
  const username = req.session.user.username;
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (req.body.display_name === undefined) return res.status(400).json({ error: 'Nothing to update' });
  const display_name = String(req.body.display_name || '').trim().slice(0, 64) || null;
  db.prepare('UPDATE users SET display_name = ? WHERE username = ?').run(display_name, username);
  req.session.user = sessionUser({ username, role: u.role, display_name });
  broadcastProjects(); // keep admins' user tables in sync
  res.json(req.session.user);
});

// Changing your own password REQUIRES the current one — a session cookie alone (e.g. a walk-up at an
// unlocked screen) shouldn't silently re-key the account. Unlike the admin reset this sets pw_hash
// directly (no TOFU/invite round-trip) and leaves the session valid, so you stay signed in.
app.post('/api/me/password', requireAuth, async (req, res) => {
  const username = req.session.user.username;
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  // An admin reset NULLs pw_hash but doesn't kill the live session, so a still-signed-in user can land
  // here with no password to verify. Don't silently re-key (that would bypass the invite-only TOFU
  // gate) — send them back through the invite link, which is the only sanctioned way to set it.
  if (!u.pw_hash) return res.status(409).json({ error: 'Your password was reset by an admin — sign out and use your invite link to set a new one.' });
  if (!(await verifyPassword(current, u.pw_hash))) return res.status(403).json({ error: 'Current password is incorrect' });
  if (!next) return res.status(400).json({ error: 'New password required' });
  { const pe = passwordPolicyError(next); if (pe) return res.status(400).json({ error: pe }); }
  const now = Date.now();
  db.prepare('UPDATE users SET pw_hash = ?, pw_changed_at = ? WHERE username = ?').run(await hashPassword(next), now, username);
  req.session.authAt = now; // keep THIS session valid; every other session (older authAt) is now invalidated
  res.json({ ok: true });
});

// ── Self-update check — notify only (Cluster E) ──────────────
// We tell admins when `origin` is ahead; we NEVER pull, install, or restart (that stays a manual,
// documented step — auto-restart-on-clean-exit, dirty-tree-on-the-live-checkout, and SSH-key
// footguns aren't worth it). Every git call runs in __dirname with a hard timeout and a
// non-interactive env, so a hung or auth-prompting fetch can't wedge the request or the poller.
const GIT_TIMEOUT = 20000;
function git(args, timeout = GIT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: __dirname, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new' } },
      (err, stdout) => err ? reject(err) : resolve(String(stdout).trim()));
  });
}
// Cached status lives in a single settings row (JSON). bootstrap serves it to admins so the badge
// shows with no git shell-out per page load; the live route + poller refresh it.
function getUpdateCache() {
  const v = db.prepare("SELECT value FROM settings WHERE key = 'update_status'").get()?.value;
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
function setUpdateCache(obj) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('update_status', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(obj));
}
// Current HEAD vs origin/<branch>. doFetch updates remote-tracking refs first (needs network/SSH;
// failure is non-fatal → we report a stale count + fetch_error). NEVER throws. A non-git install
// (downloaded zip/tarball) degrades cleanly to { isGitRepo:false }.
async function computeUpdateStatus(doFetch) {
  const checked_at = new Date().toISOString();
  let branch;
  try { branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']); }
  catch { return { isGitRepo: false, checked_at }; }
  const s = { isGitRepo: true, branch, checked_at, current: null, latest: null,
    behind: null, latestSubject: null, dirty: false, fetch_error: null };
  try { s.current = await git(['rev-parse', '--short', 'HEAD']); } catch {}
  if (doFetch) {
    try { await git(['fetch', '--quiet', 'origin', branch]); }
    catch (e) { s.fetch_error = String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 200); }
  }
  const ref = `origin/${branch}`;
  try { const n = parseInt(await git(['rev-list', '--count', `HEAD..${ref}`]), 10); s.behind = Number.isNaN(n) ? null : n; } catch {}
  try { s.latest = await git(['rev-parse', '--short', ref]); } catch {}
  try { s.latestSubject = await git(['log', '-1', '--format=%s', ref]); } catch {}
  try { s.dirty = (await git(['status', '--porcelain'])).length > 0; } catch {}
  return s;
}
// A single in-flight fetch shared by the live route AND the background poller, so concurrent calls
// (an admin clicking "Check now" while the poller ticks, or two admins at once) reuse one `git fetch`
// instead of spawning parallel fetches that contend on the repo's .git locks.
let updateStatusInFlight = null;
function fetchUpdateStatus() {
  if (updateStatusInFlight) return updateStatusInFlight;
  updateStatusInFlight = computeUpdateStatus(true)
    .then(s => { if (s.isGitRepo) setUpdateCache(s); return s; })
    .finally(() => { updateStatusInFlight = null; });
  return updateStatusInFlight;
}
// Live check (admin). Runs git (with the fetch), refreshes the cache, returns the status. Updating
// stays manual — there is deliberately NO apply/restart route.
app.get('/api/update/status', requireAdmin, async (req, res) => {
  try { res.json(await fetchUpdateStatus()); }
  catch (e) { console.error('[update] status check failed:', e && e.message); res.status(500).json({ error: 'Update check failed' }); }
});

// ── Settings (admin) ─────────────────────────────────────────
// Keep the allowlist tight so PUT can't write arbitrary keys. (update_status is intentionally NOT
// here — it's the cached check result, written by the update routine, not a user-set toggle.)
const SETTING_KEYS = new Set(['null_test_visible', 'keep_lossless', 'show_deleted_notes', 'video_enabled', 'auto_update_check']);
app.get('/api/settings', requireAdmin, (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = settingOn(k) ? '1' : '0';
  res.json(out);
});
app.put('/api/settings', requireAdmin, (req, res) => {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of SETTING_KEYS) if (req.body[k] !== undefined) set.run(k, req.body[k] ? '1' : '0');
  res.json({ ok: true });
});

// ── Background update poller (Cluster E) ─────────────────────
// Daily check when auto_update_check is on. Cheap (one fetch + a few rev-parses), guarded by an
// in-flight flag, with the setting re-read each tick (toggling it off stops checks without a
// restart) and a hard per-call timeout. On a genuine change vs the cached state, nudge admins via
// SSE. unref() so neither timer keeps the process alive at shutdown.
async function runUpdateCheck() {
  if (!settingOn('auto_update_check')) return;
  try {
    const prev = getUpdateCache();
    const s = await fetchUpdateStatus();   // shares the in-flight fetch + cache write with the live route
    if (s.isGitRepo && s.behind > 0 && (!prev || prev.latest !== s.latest || (prev.behind || 0) !== s.behind)) {
      broadcastUpdate(s);
    }
  } catch { /* never let a poll crash the process */ }
}
setTimeout(runUpdateCheck, 25000).unref();           // warm the cache shortly after boot
setInterval(runUpdateCheck, 24 * 60 * 60 * 1000).unref(); // then once a day

// ── Terminal error handler ───────────────────────────────────
// Anything that reaches here — most importantly multer's own errors on the big upload routes (file
// over the 1 GB limit, malformed multipart), which otherwise fall through to Express's default HTML
// 500 with a stack trace — becomes a clean JSON response. The client's api() helper parses JSON, so
// this is what lets the toast show a real reason; it also stops internal paths leaking in 500 bodies.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isMulter = err && err.name === 'MulterError';
  const status = isMulter ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : (err.status || 500);
  if (status >= 500) console.error('[error]', (err && err.stack) || err);
  const msg = isMulter
    ? (err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : 'Upload failed')
    : (status < 500 ? (err.message || 'Request failed') : 'Server error');
  res.status(status).json({ error: msg });
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  if (HOST === '0.0.0.0') {
    console.log(`alsegno running on http://localhost:${PORT} (and reachable on this machine's LAN IP)`);
  } else {
    console.log(`alsegno running on http://${HOST}:${PORT}`);
  }
});
