require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3458;

// ── Directories ──────────────────────────────────────────────
// Env-overridable so a throwaway test instance can point at a temp DB/uploads dir
// (DATA_DIR=/tmp/at-test/data UPLOADS_DIR=/tmp/at-test/uploads PORT=3999 node server.js)
// without touching the live store. Unset in prod ⇒ the original __dirname paths.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Database ─────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'tracker.db'));
db.pragma('journal_mode = WAL');
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

// Phase 3b settings. Only null_test_visible is wired this session (player hides the null UI when
// '0'); keep_lossless / show_deleted_notes / video_enabled arrive with their behavior in Phase 3d.
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('null_test_visible', '1')").run();

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
}

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
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}
// What we keep in the session cookie (and hand to the client) — never the pw_hash.
const sessionUser = u => ({ username: u.username, role: u.role, display_name: u.display_name || null });
// Instance setting as a boolean (missing key ⇒ default). Used by bootstrap so every role learns
// instance toggles (e.g. null_test_visible) even though GET /api/settings is admin-only.
const settingOn = (key, dflt = true) => { const v = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value; return v == null ? dflt : v === '1'; };

// ── Multer ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } }); // 1 GB

// ── ffmpeg helpers ───────────────────────────────────────────
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 512, encoding: 'buffer' }, (err, stdout, stderr) => {
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
  try {
    pcm = await run('ffmpeg', ['-v', 'error', '-i', file, '-ac', String(CH), '-ar', String(RATE), '-f', 'f32le', '-']);
  } catch { return fallback; }
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
      { maxBuffer: 1024 * 1024 * 64, encoding: 'buffer' },
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

// Shared upload→preview pipeline (used by both revision-create and revision-replace).
// Transcodes anything non-mp3 to a 320k MP3 preview, probes duration, then computes the
// waveform/peaks on the PREVIEW (so the drawn waveform matches playback) and loudness/true-peak
// on the ORIGINAL upload before it's discarded (ROADMAP 1.2 — re-encoding shifts inter-sample
// peaks / integrated loudness). Returns the stored preview + all analysis, or throws. Cleans up
// its own temp files on failure; the caller owns nothing until this resolves. A decode/no-audio
// failure throws an Error with `.status = 400` so the route can surface it as a client error.
async function processAudioUpload(file) {
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
    // Original analyzed — discard it now (this is a review tool; the preview is the kept asset).
    if (finalPath !== inputPath && fs.existsSync(inputPath)) { try { fs.unlinkSync(inputPath); } catch {} }
    const size = fs.statSync(finalPath).size;
    // Strip the real-case extension (ext is lowercased, so basename(name, ext) would miss e.g. ".WAV").
    const origName = path.basename(file.originalname, path.extname(file.originalname)) + '.mp3';
    return { storedName, finalPath, duration, size, origName, wave, loud };
  } catch (e) {
    if (fs.existsSync(inputPath)) { try { fs.unlinkSync(inputPath); } catch {} }
    if (finalPath && finalPath !== inputPath && fs.existsSync(finalPath)) { try { fs.unlinkSync(finalPath); } catch {} }
    throw e;
  }
}

// ── Express setup ────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'album-tracker-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: false, sameSite: 'lax' }
}));

// Re-read the user from the DB on every authenticated request. The session cookie is only a
// login-time snapshot; without this, deactivation and role changes wouldn't take effect until the
// user happened to log out (a deactivated admin could keep minting admins). Returns the fresh row
// or null when the account is gone or deactivated, and refreshes req.session.user in place so all
// downstream checks use the live role. One cheap indexed lookup (better-sqlite3 is synchronous) —
// mirrors how project membership (isMember) is already enforced live on each request.
function liveUser(req) {
  if (!req.session.user) return null;
  const u = db.prepare('SELECT username, role, active, display_name FROM users WHERE username = ?').get(req.session.user.username);
  if (!u || u.active === 0) return null;
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
const projectIdForAudio    = name => db.prepare('SELECT t.project_id AS p FROM revisions r JOIN tracks t ON r.track_id = t.id WHERE r.stored_name = ?').get(name)?.p ?? null;
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
function requireProjectAccess(resolve) {
  return (req, res, next) => {
    const u = liveUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    const pid = resolve(req);
    if (pid == null) return res.status(404).json({ error: 'Not found' });
    if (u.role !== 'admin' && !isMember(u.username, pid)) return res.status(403).json({ error: 'No access to this project' });
    req.projectId = pid;
    next();
  };
}
// admin → any project; otherwise must be an ENGINEER who is a member of THIS project. Clients (and
// non-member engineers) are refused. Gates everything that creates/edits tracks, revisions, files.
function requireProjectEngineer(resolve) {
  return (req, res, next) => {
    const u = liveUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    const pid = resolve(req);
    if (pid == null) return res.status(404).json({ error: 'Not found' });
    if (u.role !== 'admin' && !(u.role === 'engineer' && isMember(u.username, pid))) {
      return res.status(403).json({ error: 'Engineer access required' });
    }
    req.projectId = pid;
    next();
  };
}

// ── Auth routes ──────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.active === 0) return res.status(403).json({ error: 'Account deactivated' });

  if (!user.pw_hash) {
    // First login for this account (new user OR admin password reset) — the password they type
    // becomes the password. Deactivated accounts are refused above, before TOFU can fire.
    db.prepare('UPDATE users SET pw_hash = ? WHERE username = ?').run(hashPassword(password), username);
  } else if (!verifyPassword(password, user.pw_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.user = sessionUser(user);
  res.json(req.session.user);
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', (req, res) => {
  if (!liveUser(req)) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// ── Bootstrap + project payloads (Phase 3b) ──────────────────
// Full per-project payload: the project's tracks, each with revisions, the caller's unseen flag,
// and comment counts — the exact shape the player/studio render (scoped to one project_id).
function projectTracks(username, projectId) {
  const tracks = db.prepare('SELECT * FROM tracks WHERE project_id = ? ORDER BY sort_order, id').all(projectId);
  const revStmt = db.prepare(`SELECT id, rev_number, stored_name, original_name, duration, notes, uploaded_by, size, created_at,
                                     lufs_i, lufs_lra, true_peak
                              FROM revisions WHERE track_id = ? ORDER BY rev_number`);
  const seenStmt = db.prepare('SELECT last_seen_rev FROM seen WHERE username = ? AND track_id = ?');
  // Badges count top-level notes only — replies (parent_id NOT NULL) don't inflate the count.
  const cCount = db.prepare('SELECT COUNT(*) v FROM comments WHERE track_id = ? AND parent_id IS NULL');
  const cOpen = db.prepare('SELECT COUNT(*) v FROM comments WHERE track_id = ? AND resolved = 0 AND parent_id IS NULL');
  for (const t of tracks) {
    t.revisions = revStmt.all(t.id);
    const latest = t.revisions[t.revisions.length - 1];
    t.latest_revision_id = latest ? latest.id : null;
    const seen = seenStmt.get(username, t.id);
    t.unseen = latest ? (!seen || seen.last_seen_rev < latest.id) : false;
    t.comment_count = cCount.get(t.id).v;
    t.open_comment_count = cOpen.get(t.id).v;
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
                            WHERE t.project_id = ? AND c.parent_id IS NULL AND c.resolved = 0`);
  const avgDone = db.prepare('SELECT COALESCE(AVG(doneness), 0) v FROM tracks WHERE project_id = ?');
  // unseen: tracks in the project whose latest revision this user hasn't marked seen.
  const unseen = db.prepare(`
    SELECT COUNT(*) v FROM tracks t
    WHERE t.project_id = ?
      AND (SELECT MAX(id) FROM revisions WHERE track_id = t.id) IS NOT NULL
      AND COALESCE((SELECT last_seen_rev FROM seen WHERE username = ? AND track_id = t.id), 0)
          < (SELECT MAX(id) FROM revisions WHERE track_id = t.id)`);
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
  res.json({ user, projects, last_project_id, null_test_visible: settingOn('null_test_visible') });
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
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  const members = Array.isArray(req.body.users) ? req.body.users.map(u => String(u).trim().toLowerCase()).filter(Boolean) : [];
  const owner = req.session.user.username;
  const id = db.transaction(() => {
    const pid = db.prepare("INSERT INTO projects (type, media_type, title, owner) VALUES (?, 'audio', ?, ?)").run(type, title, owner).lastInsertRowid;
    const grant = db.prepare('INSERT OR IGNORE INTO project_users (project_id, username) VALUES (?, ?)');
    grant.run(pid, owner); // creator keeps access even if later demoted from admin
    for (const u of members) if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u)) grant.run(pid, u);
    // A song auto-creates its single track (titled like the song); a 2nd track later promotes it.
    if (type === 'song') db.prepare('INSERT INTO tracks (title, sort_order, project_id) VALUES (?, 1, ?)').run(title, pid);
    return pid;
  })();
  res.json({ id });
});

app.put('/api/projects/:id', requireAdmin, (req, res) => {
  if (!projectExists(Number(req.params.id))) return res.status(404).json({ error: 'Not found' });
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare("UPDATE projects SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, req.params.id);
  res.json({ ok: true });
});

// Delete a project: tracks have no FK to projects (Phase 3a), so cascade them explicitly
// (tracks→revisions→comments DO cascade); project_users cascades via its own FK. Unlink files after.
app.delete('/api/projects/:id', requireAdmin, (req, res) => {
  const pid = Number(req.params.id);
  if (!projectExists(pid)) return res.status(404).json({ error: 'Not found' });
  const revs = db.prepare('SELECT r.stored_name FROM revisions r JOIN tracks t ON r.track_id = t.id WHERE t.project_id = ?').all(pid);
  db.transaction(() => {
    db.prepare('DELETE FROM seen WHERE track_id IN (SELECT id FROM tracks WHERE project_id = ?)').run(pid);
    db.prepare('DELETE FROM tracks WHERE project_id = ?').run(pid);   // cascades revisions + comments
    db.prepare('UPDATE users SET last_project_id = NULL WHERE last_project_id = ?').run(pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);          // cascades project_users
  })();
  for (const r of revs) { const fp = path.join(UPLOADS_DIR, r.stored_name); if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch {} } }
  res.json({ ok: true });
});

app.post('/api/projects/:id/users', requireAdmin, (req, res) => {
  const pid = Number(req.params.id);
  if (!projectExists(pid)) return res.status(404).json({ error: 'Not found' });
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'No such user' });
  db.prepare('INSERT OR IGNORE INTO project_users (project_id, username) VALUES (?, ?)').run(pid, username);
  res.json({ ok: true });
});

app.delete('/api/projects/:id/users/:username', requireAdmin, (req, res) => {
  const pid = Number(req.params.id);
  const username = String(req.params.username || '').trim().toLowerCase();
  db.prepare('DELETE FROM project_users WHERE project_id = ? AND username = ?').run(pid, username);
  // Drop the stale auto-open hint for the revoked user (bootstrap also filters, but keep it clean).
  db.prepare('UPDATE users SET last_project_id = NULL WHERE username = ? AND last_project_id = ?').run(username, pid);
  res.json({ ok: true });
});

// ── Track routes ─────────────────────────────────────────────
// Create a track in a project. Song→album promotion: adding a 2nd track to a 'song' flips it to
// 'album' and (re)titles it from album_title — so albums get a heading + ordering they lacked.
app.post('/api/projects/:id/tracks', requireProjectEngineer(pParam), (req, res) => {
  const pid = req.projectId;
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Track title required' });
  const proj = db.prepare('SELECT type FROM projects WHERE id = ?').get(pid);
  const existing = db.prepare('SELECT COUNT(*) v FROM tracks WHERE project_id = ?').get(pid).v;
  let promoted = false;
  if (proj.type === 'song' && existing >= 1) {
    const albumTitle = String(req.body.album_title || '').trim();
    if (!albumTitle) return res.status(400).json({ error: 'Album title required to add a second track' });
    db.prepare("UPDATE projects SET type = 'album', title = ?, updated_at = datetime('now') WHERE id = ?").run(albumTitle, pid);
    promoted = true;
  }
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) v FROM tracks WHERE project_id = ?').get(pid).v;
  const r = db.prepare('INSERT INTO tracks (title, sort_order, project_id) VALUES (?, ?, ?)').run(title, max + 1, pid);
  res.json({ id: r.lastInsertRowid, promoted });
});

app.put('/api/tracks/:id', requireProjectEngineer(pTrack), (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare("UPDATE tracks SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/tracks/:id', requireProjectEngineer(pTrack), (req, res) => {
  const revs = db.prepare('SELECT stored_name FROM revisions WHERE track_id = ?').all(req.params.id);
  db.prepare('DELETE FROM tracks WHERE id = ?').run(req.params.id); // cascades revisions/comments
  for (const r of revs) { const p = path.join(UPLOADS_DIR, r.stored_name); if (fs.existsSync(p)) fs.unlinkSync(p); }
  res.json({ ok: true });
});

// Reorder tracks within a project — shared state, any project member may do it. The UPDATE is
// constrained to this project so a forged id list can't move another project's tracks.
app.put('/api/projects/:id/reorder', requireProjectAccess(pParam), (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  const stmt = db.prepare('UPDATE tracks SET sort_order = ? WHERE id = ? AND project_id = ?');
  db.transaction(ids => ids.forEach((id, i) => stmt.run(i + 1, id, req.projectId)))(order.map(Number));
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
  res.json({ ok: true, doneness: d, done_revision_id: doneRev });
});

// Mark a track's latest revision as seen by the current user
app.post('/api/tracks/:id/seen', requireProjectAccess(pTrack), (req, res) => {
  const rev = Number(req.body.revision_id) || 0;
  db.prepare(`INSERT INTO seen (username, track_id, last_seen_rev) VALUES (?, ?, ?)
              ON CONFLICT(username, track_id) DO UPDATE SET last_seen_rev = MAX(last_seen_rev, excluded.last_seen_rev)`)
    .run(req.session.user.username, req.params.id, rev);
  res.json({ ok: true });
});

// ── Revision routes ──────────────────────────────────────────
app.post('/api/tracks/:id/revisions', requireProjectEngineer(pTrack), upload.single('file'), async (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) { if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} } return res.status(404).json({ error: 'Track not found' }); }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let a;
  try {
    a = await processAudioUpload(req.file);
  } catch (e) {
    console.error('[upload] analysis failed:', e.message);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Processing failed: ' + e.message });
  }
  try {
    const nextRev = (db.prepare('SELECT COALESCE(MAX(rev_number), 0) v FROM revisions WHERE track_id = ?').get(track.id).v) + 1;
    const r = db.prepare(`INSERT INTO revisions
      (track_id, rev_number, stored_name, original_name, mime_type, size, duration, peaks, notes, uploaded_by,
       lufs_i, lufs_lra, true_peak, st_interval, st_series, peak_interval, peak_series)
      VALUES (?, ?, ?, ?, 'audio/mpeg', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(track.id, nextRev, a.storedName, a.origName, a.size, a.duration, JSON.stringify(a.wave.peaks),
           String(req.body.notes || ''), req.session.user.username,
           a.loud.i, a.loud.lra, a.loud.tp, a.loud.st_interval, JSON.stringify(a.loud.st),
           a.wave.peakInterval, JSON.stringify(a.wave.peakSeries));
    db.prepare("UPDATE tracks SET updated_at = datetime('now') WHERE id = ?").run(track.id);
    res.json({ id: r.lastInsertRowid, rev_number: nextRev, duration: a.duration, stored_name: a.storedName });
  } catch (e) {
    // DB write failed after the preview was stored — remove the now-orphaned file, leave no row behind.
    if (a.finalPath && fs.existsSync(a.finalPath)) { try { fs.unlinkSync(a.finalPath); } catch {} }
    console.error('[upload] db insert failed:', e.message);
    res.status(500).json({ error: 'Processing failed: ' + e.message });
  }
});

// Replace the audio of an EXISTING revision in place — keeps id/rev_number/notes and the whole
// comment thread; only the audio + its analysis change. Same pipeline as create (ROADMAP 2.1).
app.post('/api/revisions/:id/replace', requireProjectEngineer(pRev), upload.single('file'), async (req, res) => {
  const rev = db.prepare('SELECT * FROM revisions WHERE id = ?').get(req.params.id);
  if (!rev) { if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} } return res.status(404).json({ error: 'Revision not found' }); }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let a;
  try {
    a = await processAudioUpload(req.file);
  } catch (e) {
    console.error('[replace] analysis failed:', e.message);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Processing failed: ' + e.message });
  }
  try {
    // New stored_name UUID so the browser can't Range-serve the old bytes under the same URL.
    const tx = db.transaction(() => {
      db.prepare(`UPDATE revisions SET stored_name = ?, original_name = ?, mime_type = 'audio/mpeg',
                    size = ?, duration = ?, peaks = ?, lufs_i = ?, lufs_lra = ?, true_peak = ?,
                    st_interval = ?, st_series = ?, peak_interval = ?, peak_series = ? WHERE id = ?`)
        .run(a.storedName, a.origName, a.size, a.duration, JSON.stringify(a.wave.peaks),
             a.loud.i, a.loud.lra, a.loud.tp, a.loud.st_interval, JSON.stringify(a.loud.st),
             a.wave.peakInterval, JSON.stringify(a.wave.peakSeries), rev.id);
      // A shorter replacement can leave pins past the end — clamp them onto the new waveform.
      db.prepare('UPDATE comments SET ts = ? WHERE revision_id = ? AND ts > ?').run(a.duration, rev.id, a.duration);
      db.prepare("UPDATE tracks SET updated_at = datetime('now') WHERE id = ?").run(rev.track_id);
    });
    tx();
  } catch (e) {
    // DB update failed — the freshly-stored preview is orphaned; remove it, leave the row intact.
    if (a.finalPath && fs.existsSync(a.finalPath)) { try { fs.unlinkSync(a.finalPath); } catch {} }
    console.error('[replace] db update failed:', e.message);
    return res.status(500).json({ error: 'Processing failed: ' + e.message });
  }
  // Committed — the old preview is no longer referenced; unlink it (new UUID ⇒ never the same file).
  if (rev.stored_name && rev.stored_name !== a.storedName) {
    const p = path.join(UPLOADS_DIR, rev.stored_name);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  }
  res.json({ id: rev.id, rev_number: rev.rev_number, duration: a.duration, stored_name: a.storedName });
});

app.put('/api/revisions/:id', requireProjectEngineer(pRev), (req, res) => {
  db.prepare('UPDATE revisions SET notes = ? WHERE id = ?').run(String(req.body.notes || ''), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/revisions/:id', requireProjectEngineer(pRev), (req, res) => {
  const rev = db.prepare('SELECT * FROM revisions WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Not found' });
  // Orphan, don't cascade: comments are shown track-wide, so keep the discussion thread
  // intact — just drop the now-meaningless pin offset and any "done" pointer to this rev.
  // (The comments FK is ON DELETE CASCADE; this UPDATE clears it before the row is removed.)
  const tx = db.transaction(() => {
    db.prepare('UPDATE comments SET revision_id = NULL, ts = NULL WHERE revision_id = ?').run(req.params.id);
    db.prepare('UPDATE tracks SET done_revision_id = NULL WHERE done_revision_id = ?').run(req.params.id);
    db.prepare('DELETE FROM revisions WHERE id = ?').run(req.params.id);
  });
  tx();
  const p = path.join(UPLOADS_DIR, rev.stored_name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
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

// ── Audio streaming / download ───────────────────────────────
app.get('/api/audio/:name', requireProjectAccess(pAudio), (req, res) => {
  const rev = db.prepare('SELECT * FROM revisions WHERE stored_name = ?').get(req.params.name);
  if (!rev) return res.status(404).json({ error: 'Not found' });
  const p = path.join(UPLOADS_DIR, rev.stored_name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  if (req.query.dl) return res.download(p, rev.original_name);
  res.type('audio/mpeg');
  res.sendFile(p); // `send` adds Accept-Ranges + handles Range requests for seeking
});

// ── Comments ─────────────────────────────────────────────────
app.get('/api/tracks/:id/comments', requireProjectAccess(pTrack), (req, res) => {
  res.json(db.prepare(`SELECT c.*, r.rev_number FROM comments c
                       LEFT JOIN revisions r ON c.revision_id = r.id
                       WHERE c.track_id = ? ORDER BY c.created_at`).all(req.params.id));
});

app.post('/api/tracks/:id/comments', requireProjectAccess(pTrack), (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment body required' });
  let ts = (req.body.ts === null || req.body.ts === undefined || req.body.ts === '') ? null : Number(req.body.ts);
  let revisionId = req.body.revision_id ? Number(req.body.revision_id) : null;
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (parentId != null) {
    // Reply: parent must exist, live on this track, and itself be a top-level note (one level deep).
    const parent = db.prepare('SELECT track_id, parent_id FROM comments WHERE id = ?').get(parentId);
    if (!parent) return res.status(400).json({ error: 'Parent note not found' });
    if (parent.track_id !== Number(req.params.id)) return res.status(400).json({ error: 'Parent note is on a different track' });
    if (parent.parent_id != null) return res.status(400).json({ error: 'Cannot reply to a reply' });
    ts = null; revisionId = null; // replies are never pinned and never carry a revision
  }
  // A pinned note's revision must belong to THIS track — otherwise a member could smuggle a foreign
  // project's revision id in (leaking its existence/rev_number via the comments GET join) or trip a
  // raw FK-constraint 500. The frontend only ever sends the open track's own revision.
  if (revisionId != null) {
    const rv = db.prepare('SELECT track_id FROM revisions WHERE id = ?').get(revisionId);
    if (!rv || rv.track_id !== Number(req.params.id)) return res.status(400).json({ error: 'Revision is not on this track' });
  }
  const r = db.prepare('INSERT INTO comments (track_id, revision_id, author, ts, body, parent_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.params.id, revisionId, req.session.user.username, ts, body, parentId);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/comments/:id', requireProjectAccess(pComment), (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (req.body.resolved !== undefined) {
    if (c.parent_id != null) return res.status(400).json({ error: 'Replies cannot be resolved' });
    db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(req.body.resolved ? 1 : 0, req.params.id);
  }
  if (req.body.body !== undefined) {
    if (c.author !== req.session.user.username && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your note' });
    }
    const body = String(req.body.body).trim();
    if (!body) return res.status(400).json({ error: 'Comment body required' });
    // Only stamp edited_at when the text actually changes (avoids a no-op edit marking the note).
    if (body !== c.body) {
      db.prepare("UPDATE comments SET body = ?, edited_at = datetime('now') WHERE id = ?").run(body, req.params.id);
    }
  }
  res.json({ ok: true });
});

app.delete('/api/comments/:id', requireProjectAccess(pComment), (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.author !== req.session.user.username && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your comment' });
  }
  // Deleting a note removes its replies too — done explicitly (no FK cascade) and atomically.
  // For a reply, the children DELETE is a harmless no-op.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM comments WHERE parent_id = ?').run(req.params.id);
    db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

// ── User management (admin) ──────────────────────────────────
const ROLES = new Set(['admin', 'engineer', 'client']);
const activeAdminCount = () => db.prepare("SELECT COUNT(*) v FROM users WHERE role = 'admin' AND active = 1").get().v;

app.get('/api/admin/users', requireAdmin, (req, res) => {
  // has_password=0 ⇒ TOFU pending (new user or reset): they set it on next login.
  res.json(db.prepare(`SELECT username, role, display_name, active, created_at,
                              (pw_hash IS NOT NULL) AS has_password FROM users ORDER BY created_at, username`).all());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const role = String(req.body.role || '');
  const display_name = String(req.body.display_name || '').trim() || null;
  if (!/^[a-z0-9_.-]{2,32}$/.test(username)) return res.status(400).json({ error: 'Username must be 2–32 chars: a–z 0–9 . _ -' });
  if (!ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'Username already exists' });
  // pw_hash NULL ⇒ TOFU: the new user's first login sets their password.
  db.prepare('INSERT INTO users (username, role, display_name, active) VALUES (?, ?, ?, 1)').run(username, role, display_name);
  res.json({ ok: true });
});

app.post('/api/users/:u/reset', requireAdmin, (req, res) => {
  const username = String(req.params.u).trim().toLowerCase();
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET pw_hash = NULL WHERE username = ?').run(username); // back to TOFU
  res.json({ ok: true });
});

app.put('/api/users/:u', requireAdmin, (req, res) => {
  const username = String(req.params.u).trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) return res.status(404).json({ error: 'Not found' });
  let role = u.role, active = u.active, display_name = u.display_name;
  if (req.body.role !== undefined) { if (!ROLES.has(String(req.body.role))) return res.status(400).json({ error: 'Invalid role' }); role = String(req.body.role); }
  if (req.body.active !== undefined) active = req.body.active ? 1 : 0;
  if (req.body.display_name !== undefined) display_name = String(req.body.display_name || '').trim() || null;
  // Never strand the instance: block demoting/deactivating the last active admin.
  const wasActiveAdmin = u.role === 'admin' && u.active === 1;
  const staysActiveAdmin = role === 'admin' && active === 1;
  if (wasActiveAdmin && !staysActiveAdmin && activeAdminCount() <= 1) {
    return res.status(400).json({ error: 'Cannot demote or deactivate the last active admin' });
  }
  db.prepare('UPDATE users SET role = ?, active = ?, display_name = ? WHERE username = ?').run(role, active, display_name, username);
  // If admins edit their own role/name, refresh their live session so the UI stays in sync.
  if (username === req.session.user.username) req.session.user = sessionUser({ username, role, display_name });
  res.json({ ok: true });
});

// ── Settings (admin) ─────────────────────────────────────────
// Only null_test_visible is honored this session (player hides null UI when '0'); the rest land
// with their wiring in Phase 3d. Keep the allowlist tight so PUT can't write arbitrary keys.
const SETTING_KEYS = new Set(['null_test_visible']);
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

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => console.log(`Album Tracker running on http://127.0.0.1:${PORT}`));
