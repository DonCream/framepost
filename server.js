// server.js - main Express app
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { customAlphabet } = require('nanoid');

const db = require('./db');
const cloud = require('./cloudinary');
const ai = require('./ai');
const meta = require('./meta');
const email = require('./email');
const { normalizePhotos, validateSelection } = require('./post-helpers');

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Settings helpers ----------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---------- Hashtag helpers ----------
function getHashtagSets() {
  return db.prepare('SELECT * FROM hashtag_sets').all();
}
function buildHashtagString(setIds) {
  if (!setIds || setIds.length === 0) return '';
  const placeholders = setIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT tags FROM hashtag_sets WHERE id IN (${placeholders})`).all(...setIds);
  return rows.map((r) => r.tags).join(' ');
}
function defaultHashtagSetIds() {
  return db.prepare('SELECT id FROM hashtag_sets WHERE enabled_by_default = 1').all().map((r) => r.id);
}

// ---------- Selection resolver (used by /api/caption and /api/post) ----------
// Accepts either single (public_id/url) or array (public_ids/urls) shapes.
// Resolves URLs and platform from Cloudinary, validates same-platform, returns normalized selection.
async function resolveSelection(body) {
  let public_ids = body.public_ids;
  if (!public_ids && body.public_id) public_ids = [body.public_id];
  if (!Array.isArray(public_ids) || public_ids.length === 0) {
    throw new Error('public_ids required');
  }
  if (public_ids.length > 10) {
    throw new Error('max 10 photos per post (Instagram limit)');
  }

  // Always resolve via Cloudinary so we have URLs + platform + can validate
  const lib = await cloud.listPhotos({ limit: 500, includePosted: true });
  const byId = Object.fromEntries(lib.map((p) => [p.public_id, p]));
  const photos = public_ids.map((id) => byId[id]).filter(Boolean);
  if (photos.length !== public_ids.length) {
    throw new Error('one or more photos not found in Cloudinary');
  }
  const v = validateSelection(photos);
  if (!v.ok) throw new Error(v.error);

  return {
    public_ids,
    urls: photos.map((p) => p.url),
    platform: v.platform,
  };
}

// ---------- Auto-fill job (unchanged: still single-photo only) ----------
async function runAutofill() {
  const perDay = parseInt(getSetting('autofill_per_day') || '1', 10);
  console.log(`[autofill] running, target=${perDay}`);

  for (let i = 0; i < perDay; i++) {
    try {
      const candidate = await cloud.findCandidate();
      if (!candidate) {
        console.log('[autofill] no unposted photos found');
        break;
      }

      const { caption } = await ai.generateCaption(candidate.url);
      if (!caption) {
        console.warn('[autofill] caption generation failed; skipping this candidate');
        continue;
      }

      const token = nanoid();
      const setIds = defaultHashtagSetIds();
      db.prepare(`INSERT INTO pending_review
        (token, public_id, url, platform, caption, hashtag_sets)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        token,
        candidate.public_id,
        candidate.url,
        candidate.platform,
        caption,
        JSON.stringify(setIds)
      );

      const setNames = setIds.map((id) => db.prepare('SELECT name FROM hashtag_sets WHERE id = ?').get(id)?.name).filter(Boolean);
      await email.sendReviewEmail({
        token,
        url: candidate.url,
        platform: candidate.platform,
        caption,
        hashtagSets: setNames,
      });

      console.log(`[autofill] sent review email for ${candidate.public_id} (${candidate.platform})`);
    } catch (err) {
      console.error('[autofill] error:', err.message);
    }
  }
}

// ---------- Publish job (now carousel-aware) ----------
async function publishFromQueue() {
  const now = new Date().toISOString();
  const next = db.prepare(
    `SELECT * FROM queue WHERE status = 'queued' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT 1`
  ).get(now);

  if (!next) {
    console.log('[publish] nothing due');
    return;
  }

  const { public_ids, urls } = normalizePhotos(next);
  console.log(`[publish] publishing ${next.id} to ${next.platform} (${urls.length} photo${urls.length > 1 ? 's' : ''})`);

  const setIds = JSON.parse(next.hashtag_sets || '[]');
  const tagString = buildHashtagString(setIds);
  const fullCaption = tagString ? `${next.caption}\n\n${tagString}` : next.caption;

  try {
    const postedId = await meta.publish({
      platform: next.platform,
      urls,
      caption: fullCaption,
    });

    db.prepare(`UPDATE queue SET status = 'posted', posted_at = datetime('now') WHERE id = ?`).run(next.id);
    for (const pid of public_ids) {
      try { await cloud.tagAsPosted(pid); } catch (e) { console.warn(`tag posted failed for ${pid}:`, e.message); }
    }

    db.prepare(`INSERT INTO post_log (queue_id, platform, success, message) VALUES (?, ?, ?, ?)`)
      .run(next.id, next.platform, 1, postedId);
    console.log(`[publish] success: ${postedId}`);
  } catch (err) {
    const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    db.prepare(`UPDATE queue SET status = 'failed', error = ? WHERE id = ?`).run(message, next.id);
    db.prepare(`INSERT INTO post_log (queue_id, platform, success, message) VALUES (?, ?, ?, ?)`)
      .run(next.id, next.platform, 0, message);
    console.error('[publish] error:', message);
  }
}

// ---------- API: queue ----------
app.get('/api/queue', (req, res) => {
  const rows = db.prepare(`SELECT * FROM queue ORDER BY scheduled_at ASC`).all();
  res.json(rows.map((r) => {
    const { public_ids, urls } = normalizePhotos(r);
    return {
      ...r,
      hashtag_sets: JSON.parse(r.hashtag_sets || '[]'),
      public_ids,
      urls,
      photo_count: public_ids.length,
    };
  }));
});

app.patch('/api/queue/:id', (req, res) => {
  const { caption, scheduled_at, hashtag_sets } = req.body;
  const updates = [];
  const values = [];
  if (caption !== undefined) { updates.push('caption = ?'); values.push(caption); }
  if (scheduled_at !== undefined) { updates.push('scheduled_at = ?'); values.push(scheduled_at); }
  if (hashtag_sets !== undefined) { updates.push('hashtag_sets = ?'); values.push(JSON.stringify(hashtag_sets)); }
  if (updates.length === 0) return res.json({ ok: true });
  values.push(req.params.id);
  db.prepare(`UPDATE queue SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

app.delete('/api/queue/:id', (req, res) => {
  db.prepare('DELETE FROM queue WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/queue/:id/publish-now', async (req, res) => {
  const row = db.prepare('SELECT * FROM queue WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE queue SET scheduled_at = datetime('now') WHERE id = ?`).run(req.params.id);
  publishFromQueue().catch((e) => console.error('publish-now error', e));
  res.json({ ok: true });
});

// ---------- API: hashtag sets ----------
app.get('/api/hashtag-sets', (req, res) => {
  res.json(getHashtagSets());
});
app.post('/api/hashtag-sets', (req, res) => {
  const { name, tags, enabled_by_default } = req.body;
  const id = (name || 'set').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || nanoid();
  db.prepare('INSERT INTO hashtag_sets (id, name, tags, enabled_by_default) VALUES (?, ?, ?, ?)')
    .run(id, name, tags, enabled_by_default ? 1 : 0);
  res.json({ ok: true, id });
});
app.delete('/api/hashtag-sets/:id', (req, res) => {
  db.prepare('DELETE FROM hashtag_sets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- API: settings ----------
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const obj = {};
  rows.forEach((r) => (obj[r.key] = r.value));
  res.json(obj);
});
app.post('/api/settings', (req, res) => {
  for (const [k, v] of Object.entries(req.body)) setSetting(k, v);
  rebuildCronJobs();
  res.json({ ok: true });
});

// ---------- API: Cloudinary library (for /new) ----------
app.get('/api/library', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const items = await cloud.listPhotos({ limit });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: generate caption (single OR carousel) ----------
// Accepts:
//   { imageUrl, guidance }                 -- legacy single
//   { imageUrls: [...], guidance }         -- direct array of URLs
//   { public_ids: [...], guidance }        -- resolves via Cloudinary
app.post('/api/caption', async (req, res) => {
  const { imageUrl, imageUrls, public_ids, guidance } = req.body;
  try {
    let urls;
    if (Array.isArray(imageUrls) && imageUrls.length > 0) {
      urls = imageUrls;
    } else if (Array.isArray(public_ids) && public_ids.length > 0) {
      const sel = await resolveSelection({ public_ids });
      urls = sel.urls;
    } else if (imageUrl) {
      urls = [imageUrl];
    } else {
      return res.status(400).json({ error: 'imageUrl, imageUrls, or public_ids required' });
    }
    const result = await ai.generateCaption(urls, guidance || '');
    res.json(result);
  } catch (err) {
    console.error('[/api/caption]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: create on-the-fly post (single OR carousel) ----------
// Accepts (all back-compat):
//   public_id OR public_ids: [...]
//   caption
//   hashtag_sets OR hashtag_set_ids: [...]
//   when ('now' | ISO timestamp) OR scheduled_at (ISO) OR action ('queue'|'post_now')
app.post('/api/post', async (req, res) => {
  try {
    const sel = await resolveSelection(req.body);

    const caption = (req.body.caption || '').trim();
    if (!caption) return res.status(400).json({ error: 'caption required' });

    const hashtagSetIds = req.body.hashtag_sets || req.body.hashtag_set_ids || [];

    // Figure out scheduling
    let postNow = false;
    let scheduled_at;
    if (req.body.action === 'post_now' || req.body.when === 'now') {
      postNow = true;
      scheduled_at = new Date().toISOString();
    } else {
      scheduled_at = req.body.scheduled_at || req.body.when;
      if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required (or use action=post_now)' });
    }

    const id = nanoid();
    db.prepare(`INSERT INTO queue
      (id, public_id, url, public_ids, urls, platform, caption, hashtag_sets, scheduled_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`).run(
      id,
      sel.public_ids[0],
      sel.urls[0],
      JSON.stringify(sel.public_ids),
      JSON.stringify(sel.urls),
      sel.platform,
      caption,
      JSON.stringify(hashtagSetIds),
      scheduled_at
    );

    if (postNow) publishFromQueue().catch((e) => console.error(e));
    res.json({ ok: true, id, photo_count: sel.public_ids.length });
  } catch (err) {
    console.error('[/api/post]', err);
    res.status(400).json({ error: err.message });
  }
});

// ---------- Email button endpoints (autofill is single-photo only) ----------
app.get('/review/:token/approve', (req, res) => {
  const r = db.prepare('SELECT * FROM pending_review WHERE token = ?').get(req.params.token);
  if (!r) return res.status(404).send('Not found or already used');
  const id = nanoid();
  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(10, 0, 0, 0);
  db.prepare(`INSERT INTO queue
    (id, public_id, url, public_ids, urls, platform, caption, hashtag_sets, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, r.public_id, r.url,
    JSON.stringify([r.public_id]), JSON.stringify([r.url]),
    r.platform, r.caption, r.hashtag_sets, when.toISOString()
  );
  db.prepare('DELETE FROM pending_review WHERE token = ?').run(req.params.token);
  res.send(simplePage('✓ Added to queue', `<p>Scheduled for ${when.toLocaleString()}</p><p><a href="/queue">View queue</a></p>`));
});

app.get('/review/:token/regenerate', async (req, res) => {
  const r = db.prepare('SELECT * FROM pending_review WHERE token = ?').get(req.params.token);
  if (!r) return res.status(404).send('Not found or already used');
  try {
    const { caption } = await ai.generateCaption(r.url, 'Try a different angle than the previous attempt.');
    db.prepare('UPDATE pending_review SET caption = ? WHERE token = ?').run(caption, req.params.token);
    const setIds = JSON.parse(r.hashtag_sets || '[]');
    const setNames = setIds.map((id) => db.prepare('SELECT name FROM hashtag_sets WHERE id = ?').get(id)?.name).filter(Boolean);
    await email.sendReviewEmail({ token: req.params.token, url: r.url, platform: r.platform, caption, hashtagSets: setNames });
    res.send(simplePage('↻ Regenerated', '<p>New review email sent.</p>'));
  } catch (err) {
    res.status(500).send(simplePage('Error', `<pre>${err.message}</pre>`));
  }
});

app.get('/review/:token/postnow', async (req, res) => {
  const r = db.prepare('SELECT * FROM pending_review WHERE token = ?').get(req.params.token);
  if (!r) return res.status(404).send('Not found or already used');
  const id = nanoid();
  db.prepare(`INSERT INTO queue
    (id, public_id, url, public_ids, urls, platform, caption, hashtag_sets, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
    id, r.public_id, r.url,
    JSON.stringify([r.public_id]), JSON.stringify([r.url]),
    r.platform, r.caption, r.hashtag_sets
  );
  db.prepare('DELETE FROM pending_review WHERE token = ?').run(req.params.token);
  publishFromQueue().catch((e) => console.error(e));
  res.send(simplePage('⚡ Publishing now', '<p>Posting in the background. Check the queue for status.</p>'));
});

app.get('/review/:token/skip', (req, res) => {
  db.prepare('DELETE FROM pending_review WHERE token = ?').run(req.params.token);
  res.send(simplePage('✕ Skipped', '<p>Photo passed over.</p>'));
});

function simplePage(title, body) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{font-family:-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:20px;text-align:center;}
  h1{font-size:22px;}a{color:#3b5fa0;}</style></head>
  <body><h1>${title}</h1>${body}</body></html>`;
}

// ---------- Page routes ----------
app.get('/', (req, res) => res.redirect('/queue'));
app.get('/queue', (req, res) => res.sendFile(path.join(__dirname, 'public', 'queue.html')));
app.get('/new', (req, res) => res.sendFile(path.join(__dirname, 'public', 'new.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));

// ---------- Cron ----------
let autofillTask, publishTask;
function rebuildCronJobs() {
  if (autofillTask) autofillTask.stop();
  if (publishTask) publishTask.stop();
  const autofillCron = getSetting('autofill_cron') || '0 8 * * *';
  const publishCron = getSetting('publish_cron') || '0 10 * * 2,4';
  autofillTask = cron.schedule(autofillCron, () => runAutofill().catch((e) => console.error(e)));
  publishTask = cron.schedule(publishCron, () => publishFromQueue().catch((e) => console.error(e)));
  console.log(`[cron] autofill="${autofillCron}" publish="${publishCron}"`);
}
rebuildCronJobs();

// ---------- Manual triggers ----------
app.post('/api/run/autofill', (req, res) => { runAutofill(); res.json({ ok: true }); });
app.post('/api/run/publish', (req, res) => { publishFromQueue(); res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FramePost listening on :${PORT}`));
