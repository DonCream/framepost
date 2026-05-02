// meta.js - Instagram + Facebook publishing via Graph API
// Supports single-photo posts AND carousels (2-10 photos).
const axios = require('axios');

const GRAPH = 'https://graph.facebook.com/v21.0';

// ---------- shared helpers ----------

async function pollContainerUntilReady(creationId, token, { tries = 12, delayMs = 2500 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const status = await axios.get(`${GRAPH}/${creationId}`, {
      params: { fields: 'status_code', access_token: token },
    });
    const code = status.data.status_code;
    if (code === 'FINISHED') return true;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`IG container ${creationId} status=${code}`);
    }
  }
  throw new Error(`IG container ${creationId} did not reach FINISHED in time`);
}

// ---------- Instagram ----------

async function publishToInstagram(imageUrl, caption) {
  const igId = process.env.META_IG_BUSINESS_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;

  // 1. create container
  const containerRes = await axios.post(`${GRAPH}/${igId}/media`, null, {
    params: { image_url: imageUrl, caption, access_token: token },
  });
  const creationId = containerRes.data.id;

  // 2. wait for FINISHED
  await pollContainerUntilReady(creationId, token);

  // 3. publish
  const publishRes = await axios.post(`${GRAPH}/${igId}/media_publish`, null, {
    params: { creation_id: creationId, access_token: token },
  });
  return publishRes.data.id;
}

// imageUrls: array of 2-10 URLs, in posting order. caption: one caption for the carousel.
async function publishCarouselToInstagram(imageUrls, caption) {
  if (!Array.isArray(imageUrls) || imageUrls.length < 2 || imageUrls.length > 10) {
    throw new Error(`IG carousel needs 2-10 images, got ${imageUrls?.length}`);
  }

  const igId = process.env.META_IG_BUSINESS_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;

  // 1. create a child container for each image
  const childIds = [];
  for (const url of imageUrls) {
    const childRes = await axios.post(`${GRAPH}/${igId}/media`, null, {
      params: { image_url: url, is_carousel_item: true, access_token: token },
    });
    childIds.push(childRes.data.id);
  }

  // 2. wait for every child to FINISH (they upload async)
  for (const id of childIds) {
    await pollContainerUntilReady(id, token);
  }

  // 3. create the parent CAROUSEL container
  const parentRes = await axios.post(`${GRAPH}/${igId}/media`, null, {
    params: {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption,
      access_token: token,
    },
  });
  const parentId = parentRes.data.id;

  // 4. wait for parent
  await pollContainerUntilReady(parentId, token);

  // 5. publish parent
  const publishRes = await axios.post(`${GRAPH}/${igId}/media_publish`, null, {
    params: { creation_id: parentId, access_token: token },
  });
  return publishRes.data.id;
}

// ---------- Facebook ----------

async function publishToFacebook(imageUrl, caption) {
  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;

  const res = await axios.post(`${GRAPH}/${pageId}/photos`, null, {
    params: { url: imageUrl, caption, access_token: token },
  });
  return res.data.id;
}

async function publishCarouselToFacebook(imageUrls, caption) {
  if (!Array.isArray(imageUrls) || imageUrls.length < 2) {
    throw new Error(`FB carousel needs 2+ images, got ${imageUrls?.length}`);
  }

  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;

  // 1. upload each photo unpublished → media_fbids
  const mediaIds = [];
  for (const url of imageUrls) {
    const r = await axios.post(`${GRAPH}/${pageId}/photos`, null, {
      params: { url, published: false, access_token: token },
    });
    mediaIds.push(r.data.id);
  }

  // 2. create one feed post that attaches them all
  const attached_media = mediaIds.map((id) => ({ media_fbid: id }));
  const postRes = await axios.post(`${GRAPH}/${pageId}/feed`, null, {
    params: {
      message: caption,
      attached_media: JSON.stringify(attached_media),
      access_token: token,
    },
  });
  return postRes.data.id;
}

// ---------- unified entry point ----------
// Pass urls as a string OR an array. Function picks the right path.
async function publish({ platform, urls, caption }) {
  const list = Array.isArray(urls) ? urls : [urls];
  if (platform === 'instagram') {
    return list.length === 1
      ? publishToInstagram(list[0], caption)
      : publishCarouselToInstagram(list, caption);
  }
  if (platform === 'facebook') {
    return list.length === 1
      ? publishToFacebook(list[0], caption)
      : publishCarouselToFacebook(list, caption);
  }
  throw new Error(`Unknown platform: ${platform}`);
}

module.exports = {
  publish,
  publishToInstagram,
  publishToFacebook,
  publishCarouselToInstagram,
  publishCarouselToFacebook,
};
