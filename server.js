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
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3458;
// Bind address. Default 127.0.0.1 = the prod posture (nginx proxies to localhost). A standalone
// install (Phase 5) sets HOST=0.0.0.0 to be reachable from other devices on the LAN — install.sh
// prompts for that and writes it to .env. Loopback stays the safe default for anyone who doesn't.
const HOST = process.env.HOST || '127.0.0.1';

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

// Instance settings (Phase 3b–3d). null_test_visible: player shows the null-test button.
// keep_lossless: uploads keep the original file for lossless download. show_deleted_notes: admins
// can see soft-deleted notes. video_enabled: gate video projects (Phase 6, not built yet). media_root
// is intentionally NOT a runtime setting — it stays env-driven (UPLOADS_DIR), a Phase-5 install concern.
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('null_test_visible', '1')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('keep_lossless', '0')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('show_deleted_notes', '0')").run();
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('video_enabled', '0')").run();

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
  tadd('video_proxy_name', 'TEXT');             // 480p proxy (Phase 6c instant scrub)
  tadd('video_original_name', 'TEXT');          // uploaded filename (for display/download)
  tadd('video_original_stored_name', 'TEXT');   // kept lossless original video (keep_lossless)
  tadd('video_fps', 'REAL');
  tadd('video_width', 'INTEGER');
  tadd('video_height', 'INTEGER');
  tadd('video_duration', 'REAL');
  tadd('video_uploaded_by', 'TEXT');
  tadd('video_updated_at', 'TEXT');
  const rcols = db.prepare('PRAGMA table_info(revisions)').all().map(c => c.name);
  if (!rcols.includes('is_orig_audio')) db.exec("ALTER TABLE revisions ADD COLUMN is_orig_audio INTEGER NOT NULL DEFAULT 0");
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

// Low-quality 480p proxy for instant scrubbing (Phase 6c shows it under the HQ video until HQ is
// ready). Smaller/faster to seek; faststart so it streams immediately.
async function transcodeToVideoProxy(input, output) {
  await run('ffmpeg', ['-y', '-i', input, '-vf', 'scale=-2:480',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output]);
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
  const proxyName = crypto.randomUUID() + '_proxy.mp4';   // 480p instant-scrub proxy (6c)
  const finalPath = path.join(UPLOADS_DIR, storedName);
  const proxyPath = path.join(UPLOADS_DIR, proxyName);
  let audioName = null, audioPath = null;
  try {
    const v = await ffprobeVideo(inputPath);
    if (!v) { const e = new Error('File does not appear to be a video'); e.status = 400; throw e; }
    await transcodeToVideoPreview(inputPath, finalPath);
    await transcodeToVideoProxy(inputPath, proxyPath);
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
      video: { storedName, proxyName, originalName: file.originalname, originalStoredName,
               fps: v.fps, width: v.width, height: v.height, duration, size: fs.statSync(finalPath).size },
      origAudio
    };
  } catch (e) {
    for (const p of [inputPath, finalPath, proxyPath, audioPath]) {
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

// ── Express setup ────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// Sessions persist in SQLite (the existing tracker.db, via the same better-sqlite3 handle) rather
// than the default in-memory store, so a server restart/reboot no longer logs everyone out — it
// matters for a self-hosted box that reboots (Phase 5). The store creates its own `sessions` table
// (no FKs, additive) and sweeps expired rows every 15 min. Switching off MemoryStore logs everyone
// out exactly once, on the deploy that introduces it; sessions survive every restart after that.
app.use(session({
  store: new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }
  }),
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
const projectIdForAudio    = name => {
  // A media name is either a revision's audio (stored_name) or a track's video (HQ or proxy).
  const r = db.prepare('SELECT t.project_id AS p FROM revisions r JOIN tracks t ON r.track_id = t.id WHERE r.stored_name = ?').get(name);
  if (r) return r.p ?? null;
  const t = db.prepare('SELECT project_id AS p FROM tracks WHERE video_stored_name = ? OR video_proxy_name = ?').get(name, name);
  return t ? (t.p ?? null) : null;
};
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

// Server-sent events: one stream per browser tab. requireAuth proves the session at connect; the
// per-broadcast access check above re-proves it live thereafter. X-Accel-Buffering:no makes nginx
// stream this response unbuffered (no nginx config change needed); a :heartbeat comment every ~25s
// keeps the proxy/browser from idling the connection shut. EventSource auto-reconnects on drop.
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 5000\n\n'); // client waits 5s before reconnecting after a drop
  const client = { res, username: req.session.user.username };
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
  res.json({ user, projects, last_project_id,
    null_test_visible: settingOn('null_test_visible'),
    keep_lossless: settingOn('keep_lossless', false),
    video_enabled: settingOn('video_enabled', false) });
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
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare("UPDATE projects SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, req.params.id);
  broadcastChange(Number(req.params.id)); // members viewing it get the new title
  broadcastProjects();                    // and it re-titles in everyone's list
  res.json({ ok: true });
});

// Delete a project: tracks have no FK to projects (Phase 3a), so cascade them explicitly
// (tracks→revisions→comments DO cascade); project_users cascades via its own FK. Unlink files after.
app.delete('/api/projects/:id', requireAdmin, (req, res) => {
  const pid = Number(req.params.id);
  if (!projectExists(pid)) return res.status(404).json({ error: 'Not found' });
  const revs = db.prepare('SELECT r.stored_name, r.original_stored_name FROM revisions r JOIN tracks t ON r.track_id = t.id WHERE t.project_id = ?').all(pid);
  const vids = db.prepare('SELECT video_stored_name, video_proxy_name, video_original_stored_name FROM tracks WHERE project_id = ?').all(pid);
  db.transaction(() => {
    db.prepare('DELETE FROM seen WHERE track_id IN (SELECT id FROM tracks WHERE project_id = ?)').run(pid);
    db.prepare('DELETE FROM tracks WHERE project_id = ?').run(pid);   // cascades revisions + comments
    db.prepare('UPDATE users SET last_project_id = NULL WHERE last_project_id = ?').run(pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);          // cascades project_users
  })();
  for (const r of revs) { unlinkStored(r.stored_name); unlinkStored(r.original_stored_name); }
  for (const v of vids) { unlinkStored(v.video_stored_name); unlinkStored(v.video_proxy_name); unlinkStored(v.video_original_stored_name); }
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
  broadcastChange(pid);
  if (promoted) broadcastProjects(); // song→album: the type/title badge changes in the project list too
  res.json({ id: r.lastInsertRowid, promoted });
});

app.put('/api/tracks/:id', requireProjectEngineer(pTrack), (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare("UPDATE tracks SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, req.params.id);
  broadcastChange(req.projectId);
  res.json({ ok: true });
});

app.delete('/api/tracks/:id', requireProjectEngineer(pTrack), (req, res) => {
  const revs = db.prepare('SELECT stored_name, original_stored_name FROM revisions WHERE track_id = ?').all(req.params.id);
  const trk = db.prepare('SELECT video_stored_name, video_proxy_name, video_original_stored_name FROM tracks WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM tracks WHERE id = ?').run(req.params.id); // cascades revisions/comments
  for (const r of revs) { unlinkStored(r.stored_name); unlinkStored(r.original_stored_name); }
  if (trk) { unlinkStored(trk.video_stored_name); unlinkStored(trk.video_proxy_name); unlinkStored(trk.video_original_stored_name); }
  broadcastChange(req.projectId);
  res.json({ ok: true });
});

// Reorder tracks within a project — shared state, any project member may do it. The UPDATE is
// constrained to this project so a forged id list can't move another project's tracks.
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
app.post('/api/tracks/:id/video', requireProjectEngineer(pTrack), upload.single('file'), async (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) { if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} } return res.status(404).json({ error: 'Track not found' }); }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const proj = db.prepare('SELECT media_type FROM projects WHERE id = ?').get(req.projectId);
  if (!proj || proj.media_type !== 'video') { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'Not a video project' }); }

  let a;
  try { a = await processTrackVideo(req.file, settingOn('keep_lossless', false)); }
  catch (e) { console.error('[track-video] failed:', e.message); return res.status(e.status || 500).json({ error: e.status ? e.message : 'Processing failed: ' + e.message }); }

  const old = { v: track.video_stored_name, p: track.video_proxy_name, ov: track.video_original_stored_name };
  const oldOrig = db.prepare('SELECT id, stored_name, original_stored_name FROM revisions WHERE track_id = ? AND is_orig_audio = 1').get(track.id);
  const oa = a.origAudio;
  const oaName = oa ? (path.basename(a.video.originalName, path.extname(a.video.originalName)) || 'audio') + '.mp3' : null;
  try {
    db.transaction(() => {
      db.prepare(`UPDATE tracks SET video_stored_name=?, video_proxy_name=?, video_original_name=?, video_original_stored_name=?,
                    video_fps=?, video_width=?, video_height=?, video_duration=?, video_uploaded_by=?, video_updated_at=datetime('now'),
                    updated_at=datetime('now') WHERE id=?`)
        .run(a.video.storedName, a.video.proxyName, a.video.originalName, a.video.originalStoredName,
             a.video.fps, a.video.width, a.video.height, a.video.duration, req.session.user.username, track.id);
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
          .run(track.id, oa.storedName, oaName, oa.size, oa.duration, JSON.stringify(oa.wave.peaks), req.session.user.username,
               oa.loud.i, oa.loud.lra, oa.loud.tp, oa.loud.st_interval, JSON.stringify(oa.loud.st),
               oa.wave.peakInterval, JSON.stringify(oa.wave.peakSeries));
      } else if (oldOrig) {
        // New picture is SILENT but a stale Original-audio rev (from the old picture) exists — drop it
        // so the player never presents the old video's audio as the new picture's "Original audio".
        // Orphan its comments/pins + clear any done pointer, mirroring DELETE /api/revisions.
        db.prepare('UPDATE comments SET revision_id = NULL, ts = NULL WHERE revision_id = ?').run(oldOrig.id);
        db.prepare('UPDATE tracks SET done_revision_id = NULL WHERE done_revision_id = ?').run(oldOrig.id);
        db.prepare('DELETE FROM revisions WHERE id = ?').run(oldOrig.id);
      }
    })();
  } catch (e) {
    unlinkStored(a.video.storedName); unlinkStored(a.video.proxyName); unlinkStored(a.video.originalStoredName);
    if (oa) unlinkStored(oa.storedName);
    console.error('[track-video] db failed:', e.message);
    return res.status(500).json({ error: 'Processing failed: ' + e.message });
  }
  // committed — unlink the replaced video files, and the Original-audio's old files when refreshed
  if (old.v && old.v !== a.video.storedName) unlinkStored(old.v);
  if (old.p && old.p !== a.video.proxyName) unlinkStored(old.p);
  if (old.ov && old.ov !== a.video.originalStoredName) unlinkStored(old.ov);
  if (oldOrig) {  // the old Original-audio's files are unreferenced now (refreshed in place, or dropped)
    if (!oa || oldOrig.stored_name !== oa.storedName) unlinkStored(oldOrig.stored_name);
    unlinkStored(oldOrig.original_stored_name);
  }
  broadcastChange(req.projectId);
  res.json({ ok: true });
});

// ── Revision routes ──────────────────────────────────────────
app.post('/api/tracks/:id/revisions', requireProjectEngineer(pTrack), upload.single('file'), async (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) { if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} } return res.status(404).json({ error: 'Track not found' }); }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // A revision is always AUDIO — for a video project it's an audio MIX that plays in sync with the
  // track's video (the picture is a separate track-level asset, set via POST /api/tracks/:id/video).
  let a;
  try {
    a = await processAudioUpload(req.file, settingOn('keep_lossless', false));
  } catch (e) {
    console.error('[upload] analysis failed:', e.message);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Processing failed: ' + e.message });
  }
  try {
    const nextRev = (db.prepare('SELECT COALESCE(MAX(rev_number), 0) v FROM revisions WHERE track_id = ?').get(track.id).v) + 1;
    const r = db.prepare(`INSERT INTO revisions
      (track_id, rev_number, stored_name, original_name, original_stored_name, mime_type, size, duration, peaks, notes, uploaded_by,
       lufs_i, lufs_lra, true_peak, st_interval, st_series, peak_interval, peak_series)
      VALUES (?, ?, ?, ?, ?, 'audio/mpeg', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(track.id, nextRev, a.storedName, a.origName, a.originalStoredName, a.size, a.duration, JSON.stringify(a.wave.peaks),
           String(req.body.notes || ''), req.session.user.username,
           a.loud.i, a.loud.lra, a.loud.tp, a.loud.st_interval, JSON.stringify(a.loud.st),
           a.wave.peakInterval, JSON.stringify(a.wave.peakSeries));
    db.prepare("UPDATE tracks SET updated_at = datetime('now') WHERE id = ?").run(track.id);
    broadcastChange(req.projectId); // a new revision: reviewers' "NEW", rev count, latest all change
    res.json({ id: r.lastInsertRowid, rev_number: nextRev, duration: a.duration, stored_name: a.storedName });
  } catch (e) {
    // DB write failed after files were stored — remove the now-orphaned preview + kept original.
    unlinkStored(a.storedName); unlinkStored(a.originalStoredName);
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
  // The "Original audio" revision is derived from the track's video — it can't be replaced directly;
  // replace the video instead (POST /api/tracks/:id/video regenerates it).
  if (rev.is_orig_audio) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'The original audio is set by the video — replace the video to change it.' }); }

  let a;
  try {
    a = await processAudioUpload(req.file, settingOn('keep_lossless', false));
  } catch (e) {
    console.error('[replace] analysis failed:', e.message);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Processing failed: ' + e.message });
  }
  try {
    // New stored_name UUID so the browser can't Range-serve the old bytes under the same URL.
    const tx = db.transaction(() => {
      db.prepare(`UPDATE revisions SET stored_name = ?, original_name = ?, original_stored_name = ?, mime_type = 'audio/mpeg',
                    size = ?, duration = ?, peaks = ?, lufs_i = ?, lufs_lra = ?, true_peak = ?,
                    st_interval = ?, st_series = ?, peak_interval = ?, peak_series = ? WHERE id = ?`)
        .run(a.storedName, a.origName, a.originalStoredName, a.size, a.duration, JSON.stringify(a.wave.peaks),
             a.loud.i, a.loud.lra, a.loud.tp, a.loud.st_interval, JSON.stringify(a.loud.st),
             a.wave.peakInterval, JSON.stringify(a.wave.peakSeries), rev.id);
      // A shorter replacement can leave pins past the end — clamp them onto the new waveform.
      db.prepare('UPDATE comments SET ts = ? WHERE revision_id = ? AND ts > ?').run(a.duration, rev.id, a.duration);
      db.prepare("UPDATE tracks SET updated_at = datetime('now') WHERE id = ?").run(rev.track_id);
    });
    tx();
  } catch (e) {
    // DB update failed — the freshly-stored files are orphaned; remove them, leave the row intact.
    unlinkStored(a.storedName); unlinkStored(a.originalStoredName);
    console.error('[replace] db update failed:', e.message);
    return res.status(500).json({ error: 'Processing failed: ' + e.message });
  }
  // Committed — the old preview + old kept original are no longer referenced (new UUIDs); unlink both.
  if (rev.stored_name !== a.storedName) unlinkStored(rev.stored_name);
  if (rev.original_stored_name && rev.original_stored_name !== a.originalStoredName) unlinkStored(rev.original_stored_name);
  broadcastChange(req.projectId); // analysis/waveform/stored_name changed — listeners refetch metadata
  res.json({ id: rev.id, rev_number: rev.rev_number, duration: a.duration, stored_name: a.storedName });
});

app.put('/api/revisions/:id', requireProjectEngineer(pRev), (req, res) => {
  db.prepare('UPDATE revisions SET notes = ? WHERE id = ?').run(String(req.body.notes || ''), req.params.id);
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
  const trk = rev ? null : db.prepare('SELECT * FROM tracks WHERE video_stored_name = ? OR video_proxy_name = ?').get(name, name);
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
  const body = String(req.body.body || '').trim();
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
    const rv = db.prepare('SELECT track_id FROM revisions WHERE id = ?').get(revisionId);
    if (!rv || rv.track_id !== Number(req.params.id)) return res.status(400).json({ error: 'Revision is not on this track' });
  }
  const r = db.prepare('INSERT INTO comments (track_id, revision_id, author, ts, body, parent_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.params.id, revisionId, req.session.user.username, ts, body, parentId);
  broadcastChange(req.projectId);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/comments/:id', requireProjectAccess(pComment), (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.deleted_at != null) return res.status(400).json({ error: 'Note was deleted' });
  let mutated = false;
  if (req.body.resolved !== undefined) {
    if (c.parent_id != null) return res.status(400).json({ error: 'Replies cannot be resolved' });
    db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(req.body.resolved ? 1 : 0, req.params.id);
    mutated = true;
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
      mutated = true;
    }
  }
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
  broadcastProjects(); // keep other admins' user tables in sync
  res.json({ ok: true });
});

app.post('/api/users/:u/reset', requireAdmin, (req, res) => {
  const username = String(req.params.u).trim().toLowerCase();
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET pw_hash = NULL WHERE username = ?').run(username); // back to TOFU
  broadcastProjects(); // refresh the "password pending" pill on other admins' user tables
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
  // Role/active changes ripple through access (engineer↔client gating, deactivation) and the admin
  // user table — every client re-validates its scoped view.
  broadcastProjects();
  res.json({ ok: true });
});

// ── Settings (admin) ─────────────────────────────────────────
// Only null_test_visible is honored this session (player hides null UI when '0'); the rest land
// with their wiring in Phase 3d. Keep the allowlist tight so PUT can't write arbitrary keys.
const SETTING_KEYS = new Set(['null_test_visible', 'keep_lossless', 'show_deleted_notes', 'video_enabled']);
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
app.listen(PORT, HOST, () => {
  if (HOST === '0.0.0.0') {
    console.log(`Album Tracker running on http://localhost:${PORT} (and reachable on this machine's LAN IP)`);
  } else {
    console.log(`Album Tracker running on http://${HOST}:${PORT}`);
  }
});
