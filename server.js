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
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
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
`);

// Seed users (TOFU — pw_hash stays NULL until first login sets it)
const seedUser = db.prepare('INSERT OR IGNORE INTO users (username, role) VALUES (?, ?)');
seedUser.run('james', 'admin');
seedUser.run('noah', 'artist');

// Seed album title
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('album_title', ?)")
  .run('Noah Praise God — Album');

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

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Only James can do that' });
  next();
}

// ── Auth routes ──────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  if (!user.pw_hash) {
    // First login for this account — the password they type becomes the password.
    db.prepare('UPDATE users SET pw_hash = ? WHERE username = ?').run(hashPassword(password), username);
  } else if (!verifyPassword(password, user.pw_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.user = { username: user.username, role: user.role };
  res.json(req.session.user);
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// ── Bootstrap (everything the UI needs in one call) ──────────
function trackPayload(username) {
  const tracks = db.prepare('SELECT * FROM tracks ORDER BY sort_order, id').all();
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

app.get('/api/bootstrap', requireAuth, (req, res) => {
  res.json({
    user: req.session.user,
    album_title: db.prepare("SELECT value FROM settings WHERE key = 'album_title'").get()?.value || 'Album',
    tracks: trackPayload(req.session.user.username)
  });
});

// ── Album ────────────────────────────────────────────────────
app.put('/api/album', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('album_title', ?)").run(title);
  res.json({ ok: true });
});

// ── Track routes ─────────────────────────────────────────────
app.post('/api/tracks', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) v FROM tracks').get().v;
  const r = db.prepare('INSERT INTO tracks (title, sort_order) VALUES (?, ?)').run(title, max + 1);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/tracks/:id', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare("UPDATE tracks SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/tracks/:id', requireAdmin, (req, res) => {
  const revs = db.prepare('SELECT stored_name FROM revisions WHERE track_id = ?').all(req.params.id);
  db.prepare('DELETE FROM tracks WHERE id = ?').run(req.params.id); // cascades revisions/comments
  for (const r of revs) { const p = path.join(UPLOADS_DIR, r.stored_name); if (fs.existsSync(p)) fs.unlinkSync(p); }
  res.json({ ok: true });
});

// Reorder — both users may reorder; order is shared
app.put('/api/reorder', requireAuth, (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  const stmt = db.prepare('UPDATE tracks SET sort_order = ? WHERE id = ?');
  const tx = db.transaction((ids) => { ids.forEach((id, i) => stmt.run(i + 1, id)); });
  tx(order.map(Number));
  res.json({ ok: true });
});

// Doneness — Noah's call (any authed user may set it)
app.put('/api/tracks/:id/doneness', requireAuth, (req, res) => {
  let d = parseInt(req.body.doneness, 10);
  if (isNaN(d)) return res.status(400).json({ error: 'doneness required' });
  d = Math.max(0, Math.min(100, d));
  let doneRev = null;
  if (d >= 100) {
    doneRev = req.body.revision_id
      ? Number(req.body.revision_id)
      : db.prepare('SELECT MAX(id) v FROM revisions WHERE track_id = ?').get(req.params.id).v;
  }
  db.prepare("UPDATE tracks SET doneness = ?, done_revision_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(d, doneRev, req.params.id);
  res.json({ ok: true, doneness: d, done_revision_id: doneRev });
});

// Mark a track's latest revision as seen by the current user
app.post('/api/tracks/:id/seen', requireAuth, (req, res) => {
  const rev = Number(req.body.revision_id) || 0;
  db.prepare(`INSERT INTO seen (username, track_id, last_seen_rev) VALUES (?, ?, ?)
              ON CONFLICT(username, track_id) DO UPDATE SET last_seen_rev = MAX(last_seen_rev, excluded.last_seen_rev)`)
    .run(req.session.user.username, req.params.id, rev);
  res.json({ ok: true });
});

// ── Revision routes ──────────────────────────────────────────
app.post('/api/tracks/:id/revisions', requireAdmin, upload.single('file'), async (req, res) => {
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
app.post('/api/revisions/:id/replace', requireAdmin, upload.single('file'), async (req, res) => {
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

app.put('/api/revisions/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE revisions SET notes = ? WHERE id = ?').run(String(req.body.notes || ''), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/revisions/:id', requireAdmin, (req, res) => {
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

app.get('/api/revisions/:id/peaks', requireAuth, (req, res) => {
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
app.get('/api/audio/:name', requireAuth, (req, res) => {
  const rev = db.prepare('SELECT * FROM revisions WHERE stored_name = ?').get(req.params.name);
  if (!rev) return res.status(404).json({ error: 'Not found' });
  const p = path.join(UPLOADS_DIR, rev.stored_name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  if (req.query.dl) return res.download(p, rev.original_name);
  res.type('audio/mpeg');
  res.sendFile(p); // `send` adds Accept-Ranges + handles Range requests for seeking
});

// ── Comments ─────────────────────────────────────────────────
app.get('/api/tracks/:id/comments', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT c.*, r.rev_number FROM comments c
                       LEFT JOIN revisions r ON c.revision_id = r.id
                       WHERE c.track_id = ? ORDER BY c.created_at`).all(req.params.id));
});

app.post('/api/tracks/:id/comments', requireAuth, (req, res) => {
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
  const r = db.prepare('INSERT INTO comments (track_id, revision_id, author, ts, body, parent_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.params.id, revisionId, req.session.user.username, ts, body, parentId);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/comments/:id', requireAuth, (req, res) => {
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

app.delete('/api/comments/:id', requireAuth, (req, res) => {
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

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => console.log(`Album Tracker running on http://127.0.0.1:${PORT}`));
