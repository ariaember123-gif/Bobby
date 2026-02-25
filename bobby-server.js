/**
 * Bobby Wa Groove — $GROOVE Backend Server
 * Node.js + Express + SQLite Database
 *
 * Install:  npm install express better-sqlite3 cors helmet
 * Run:      node bobby-server.js
 * API:      http://localhost:3001
 */

const express  = require('express');
const Database = require('better-sqlite3');
const cors     = require('cors');
const helmet   = require('helmet');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Database ────────────────────────────────────────────────────────────────
const db = new Database('groove.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL DEFAULT 'Anon',
    tag        TEXT,
    text       TEXT    NOT NULL,
    likes      INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_hash    TEXT
  );

  CREATE TABLE IF NOT EXISTS likes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL,
    uid        TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, uid)
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event      TEXT    NOT NULL,
    meta       TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS token_stats (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
`);

// Seed token stats
if (db.prepare('SELECT COUNT(*) as c FROM token_stats').get().c === 0) {
  ['holders','market_cap','price_usd','volume_24h','price_change_24h'].forEach(k =>
    db.prepare('INSERT OR REPLACE INTO token_stats (key,value) VALUES (?,?)').run(k,'0')
  );
}

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return h.toString(16);
}

// ── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'grooving', coin: '$GROOVE', ca: '63r4myDNoB6aaHtxkgfLDVwvmftk9UZoHKtWs9mSpump' });
});

// Posts
app.get('/api/posts', (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const uid   = req.query.uid || '';
  const posts = db.prepare(`
    SELECT p.*, CASE WHEN l.uid IS NOT NULL THEN 1 ELSE 0 END as liked_by_me
    FROM posts p
    LEFT JOIN likes l ON l.post_id = p.id AND l.uid = ?
    ORDER BY p.created_at DESC LIMIT ? OFFSET ?
  `).all(uid, limit, (page-1)*limit);
  res.json({ posts, total: db.prepare('SELECT COUNT(*) as c FROM posts').get().c, page });
});

app.post('/api/posts', (req, res) => {
  const { name, tag, text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text required' });
  if (text.length > 280)  return res.status(400).json({ error: 'Max 280 chars' });

  const ip     = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ipHash = simpleHash(ip);
  const recent = db.prepare(`SELECT COUNT(*) as c FROM posts WHERE ip_hash=? AND created_at > datetime('now','-1 hour')`).get(ipHash);
  if (recent.c >= 5) return res.status(429).json({ error: 'Max 5 posts/hour, take a dance break 🕺' });

  const r = db.prepare('INSERT INTO posts (name,tag,text,ip_hash) VALUES (?,?,?,?)').run(
    (name||'Anon').toString().slice(0,30).trim(),
    (tag||'').toString().slice(0,20).trim() || null,
    text.toString().slice(0,280).trim(),
    ipHash
  );
  res.status(201).json({ ...db.prepare('SELECT * FROM posts WHERE id=?').get(r.lastInsertRowid), liked_by_me: 0 });
});

app.post('/api/posts/:id/like', (req, res) => {
  const id  = parseInt(req.params.id);
  const uid = req.body.uid;
  if (!uid) return res.status(400).json({ error: 'uid required' });
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  const existing = db.prepare('SELECT * FROM likes WHERE post_id=? AND uid=?').get(id, uid);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE post_id=? AND uid=?').run(id, uid);
    db.prepare('UPDATE posts SET likes=MAX(0,likes-1) WHERE id=?').run(id);
  } else {
    db.prepare('INSERT INTO likes (post_id,uid) VALUES (?,?)').run(id, uid);
    db.prepare('UPDATE posts SET likes=likes+1 WHERE id=?').run(id);
  }
  res.json({ ...db.prepare('SELECT * FROM posts WHERE id=?').get(id), liked: !existing });
});

app.delete('/api/posts/:id', (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(403).json({error:'Unauthorized'});
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Stats
app.get('/api/stats', (_req, res) => {
  const stats = Object.fromEntries(db.prepare('SELECT key,value FROM token_stats').all().map(r=>[r.key,r.value]));
  stats.total_posts = db.prepare('SELECT COUNT(*) as c FROM posts').get().c;
  stats.total_likes = db.prepare('SELECT COALESCE(SUM(likes),0) as t FROM posts').get().t;
  res.json(stats);
});

app.post('/api/stats', (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(403).json({error:'Unauthorized'});
  const allowed = ['holders','market_cap','price_usd','volume_24h','price_change_24h'];
  const ins = db.prepare('INSERT OR REPLACE INTO token_stats (key,value) VALUES (?,?)');
  for (const [k,v] of Object.entries(req.body)) { if(allowed.includes(k)) ins.run(k,String(v)); }
  res.json({ success: true });
});

// Analytics
app.post('/api/analytics', (req, res) => {
  const { event, meta } = req.body;
  if (!event) return res.status(400).json({ error: 'event required' });
  db.prepare('INSERT INTO analytics (event,meta) VALUES (?,?)').run(event.slice(0,50), meta?JSON.stringify(meta).slice(0,500):null);
  res.json({ success: true });
});

// Serve frontend
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'bobby-wagroove.html')));

app.listen(PORT, () => console.log(`
╔══════════════════════════════════════════╗
║    Bobby Wa Groove — $GROOVE API 🕺     ║
╠══════════════════════════════════════════╣
║  Server: http://localhost:${PORT}          ║
║  CA: 63r4myDNoB6...9mSpump               ║
╚══════════════════════════════════════════╝
`));

module.exports = app;
