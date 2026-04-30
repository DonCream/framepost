// cloudinary.js - photo selection and tagging
const cloudinary = require('cloudinary').v2;
const db = require('./db');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function getLastPlatform() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'last_autofill_platform'").get();
  return row?.value || null;
}
function setLastPlatform(platform) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('last_autofill_platform', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(platform);
}

// Returns the set of public_ids that are currently locked up — either pending review
// or already in the queue waiting to publish. We exclude these from candidate selection.
function getInFlightPublicIds() {
  const pending = db.prepare('SELECT public_id FROM pending_review').all().map((r) => r.public_id);
  const queued = db
    .prepare("SELECT public_id FROM queue WHERE status IN ('queued', 'posted')")
    .all()
    .map((r) => r.public_id);
  return new Set([...pending, ...queued]);
}

// Pick a single unposted photo, strictly alternating platforms run-to-run.
// Skips photos that are already pending review or in the queue.
async function findCandidate() {
  const last = getLastPlatform();
  const tryFirst = last === 'instagram' ? 'facebook' : 'instagram';
  const trySecond = tryFirst === 'instagram' ? 'facebook' : 'instagram';
  const inFlight = getInFlightPublicIds();

  for (const platform of [tryFirst, trySecond]) {
    // Pull a small batch so we can skip in-flight ones in code (Cloudinary search
    // doesn't support arbitrary public_id exclusion lists).
    const result = await cloudinary.search
      .expression(`tags=${platform} AND -tags=posted`)
      .with_field('tags')
      .sort_by('created_at', 'desc')
      .max_results(50)
      .execute();

    const fresh = result.resources.find((r) => !inFlight.has(r.public_id));
    if (fresh) {
      setLastPlatform(platform);
      return {
        public_id: fresh.public_id,
        url: fresh.secure_url,
        platform,
      };
    }
  }

  return null;
}

// List unposted photos for the /new page browser. Mixes IG and FB.
async function listPhotos({ limit = 50, includePosted = false } = {}) {
  const expr = includePosted
    ? '(tags=instagram OR tags=facebook)'
    : '(tags=instagram OR tags=facebook) AND -tags=posted';

  const result = await cloudinary.search
    .expression(expr)
    .with_field('tags')
    .sort_by('created_at', 'desc')
    .max_results(limit)
    .execute();

  const inFlight = getInFlightPublicIds();

  return result.resources
    .map((asset) => {
      if (inFlight.has(asset.public_id)) return null;
      const tags = asset.tags || [];
      let platform = null;
      if (tags.includes('instagram')) platform = 'instagram';
      else if (tags.includes('facebook')) platform = 'facebook';
      if (!platform) return null;
      return {
        public_id: asset.public_id,
        url: asset.secure_url,
        platform,
        created_at: asset.created_at,
      };
    })
    .filter(Boolean);
}

async function tagAsPosted(publicId) {
  return cloudinary.uploader.add_tag('posted', [publicId]);
}

module.exports = { findCandidate, listPhotos, tagAsPosted };
