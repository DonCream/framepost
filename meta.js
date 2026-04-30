// meta.js - Instagram or Facebook publishing via Graph API (one platform per post)
const axios = require('axios');

const GRAPH = 'https://graph.facebook.com/v21.0';

async function publishToInstagram(imageUrl, caption) {
  const igId = process.env.META_IG_BUSINESS_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;

  // Step 1: create media container
  const containerRes = await axios.post(`${GRAPH}/${igId}/media`, null, {
    params: { image_url: imageUrl, caption, access_token: token },
  });
  const creationId = containerRes.data.id;

  // Step 2: poll for FINISHED status
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await axios.get(`${GRAPH}/${creationId}`, {
      params: { fields: 'status_code', access_token: token },
    });
    if (status.data.status_code === 'FINISHED') break;
    if (status.data.status_code === 'ERROR') {
      throw new Error('Instagram media container error');
    }
  }

  // Step 3: publish
  const publishRes = await axios.post(`${GRAPH}/${igId}/media_publish`, null, {
    params: { creation_id: creationId, access_token: token },
  });
  return publishRes.data.id;
}

async function publishToFacebook(imageUrl, caption) {
  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;

  const res = await axios.post(`${GRAPH}/${pageId}/photos`, null, {
    params: { url: imageUrl, caption, access_token: token },
  });
  return res.data.id;
}

// Publish to whichever platform the post is for
async function publish({ url, caption, platform }) {
  if (platform === 'instagram') {
    const id = await publishToInstagram(url, caption);
    return { platform: 'instagram', id };
  }
  if (platform === 'facebook') {
    const id = await publishToFacebook(url, caption);
    return { platform: 'facebook', id };
  }
  throw new Error(`Unknown platform: ${platform}`);
}

module.exports = { publish, publishToInstagram, publishToFacebook };
