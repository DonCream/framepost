// post-helpers.js
// Helpers for normalizing posts that may be single-photo or carousels.
// Add this file to ~/framepost/ and require it from server.js.

// Given a queue or pending_review row, return a normalized {public_ids, urls} arrays.
// Falls back to legacy single-photo columns if the new array columns are NULL.
function normalizePhotos(row) {
  if (!row) return { public_ids: [], urls: [] };
  if (row.public_ids && row.urls) {
    try {
      const public_ids = JSON.parse(row.public_ids);
      const urls = JSON.parse(row.urls);
      if (Array.isArray(public_ids) && public_ids.length > 0) {
        return { public_ids, urls };
      }
    } catch (e) {
      // fall through to legacy
    }
  }
  // legacy single-photo
  return {
    public_ids: row.public_id ? [row.public_id] : [],
    urls: row.url ? [row.url] : [],
  };
}

function isCarousel(row) {
  return normalizePhotos(row).public_ids.length > 1;
}

// Validate a list of selected photos from /new before queuing
function validateSelection(photos) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return { ok: false, error: 'no photos selected' };
  }
  if (photos.length > 10) {
    return { ok: false, error: 'maximum 10 photos per post (Instagram limit)' };
  }
  const platforms = new Set(photos.map((p) => p.platform));
  if (platforms.size > 1) {
    return { ok: false, error: 'all photos must be the same platform' };
  }
  if (!platforms.has('instagram') && !platforms.has('facebook')) {
    return { ok: false, error: 'photos must have instagram or facebook tag' };
  }
  return { ok: true, platform: [...platforms][0] };
}

module.exports = { normalizePhotos, isCarousel, validateSelection };
