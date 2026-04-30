// db.js - SQLite setup
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'framepost.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS queue (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    url TEXT NOT NULL,
    platform TEXT NOT NULL,           -- 'instagram' | 'facebook'
    caption TEXT NOT NULL,
    hashtag_sets TEXT NOT NULL DEFAULT '[]',
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    posted_at TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS pending_review (
    token TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    url TEXT NOT NULL,
    platform TEXT NOT NULL,
    caption TEXT NOT NULL,
    hashtag_sets TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hashtag_sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tags TEXT NOT NULL,
    enabled_by_default INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS post_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id TEXT,
    platform TEXT NOT NULL,
    success INTEGER NOT NULL,
    message TEXT,
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed default settings
const defaults = {
  autofill_per_day: process.env.AUTOFILL_PER_DAY || '1',
  autofill_cron: process.env.AUTOFILL_CRON || '0 8 * * *',
  publish_cron: process.env.PUBLISH_CRON || '0 10 * * 2,4',
  queue_threshold: '5',
};
const setSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) setSetting.run(k, v);

// Seed default hashtag sets
const setCount = db.prepare('SELECT COUNT(*) as n FROM hashtag_sets').get().n;
if (setCount === 0) {
  const insertSet = db.prepare(
    'INSERT INTO hashtag_sets (id, name, tags, enabled_by_default) VALUES (?, ?, ?, ?)'
  );
  insertSet.run('street', 'Street', '#streetphotography #streettogs #urbanphotography', 0);
  insertSet.run('portrait', 'Portrait', '#portrait #portraitphotography #portraitmood', 0);
  insertSet.run('detroit', 'Detroit', '#detroit #puremichigan #detroitphotographer', 1);
  insertSet.run('webjelly', 'WebJelly', '#webjellystudios', 1);
}

module.exports = db;
