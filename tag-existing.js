// tag-existing.js - one-shot script to tag photos in Framepost/instagram and Framepost/facebook folders
//
// Usage:
//   cd ~/framepost
//   node tag-existing.js
//
// What it does:
//   - Walks every asset in folder "Framepost/instagram" and adds tag "instagram"
//   - Walks every asset in folder "Framepost/facebook" and adds tag "facebook"
//   - Idempotent: re-running won't duplicate tags

require('dotenv').config();
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function listAllInFolder(folderPath) {
  const all = [];
  let nextCursor = null;
  do {
    const params = {
      type: 'upload',
      prefix: folderPath + '/',
      max_results: 500,
      tags: true, // include tags array in response
    };
    if (nextCursor) params.next_cursor = nextCursor;
    const res = await cloudinary.api.resources(params);
    all.push(...res.resources);
    nextCursor = res.next_cursor;
  } while (nextCursor);
  return all;
}

async function tagBatch(publicIds, tag) {
  if (publicIds.length === 0) return;
  const batchSize = 100;
  for (let i = 0; i < publicIds.length; i += batchSize) {
    const batch = publicIds.slice(i, i + batchSize);
    await cloudinary.uploader.add_tag(tag, batch);
    console.log(`  - tagged ${batch.length} assets with "${tag}" (${i + batch.length}/${publicIds.length})`);
  }
}

function safeTags(asset) {
  return Array.isArray(asset.tags) ? asset.tags.join(', ') : 'none';
}

(async () => {
  console.log('=== FramePost bulk tagger ===\n');

  // Instagram folder
  console.log('Scanning Framepost/instagram...');
  const igAssets = await listAllInFolder('Framepost/instagram');
  console.log(`Found ${igAssets.length} assets in Framepost/instagram`);
  if (igAssets.length > 0) {
    console.log('Sample:');
    igAssets.slice(0, 3).forEach((a) =>
      console.log(`  - ${a.public_id} (current tags: ${safeTags(a)})`)
    );
    await tagBatch(
      igAssets.map((a) => a.public_id),
      'instagram'
    );
  }

  console.log('');

  // Facebook folder
  console.log('Scanning Framepost/facebook...');
  const fbAssets = await listAllInFolder('Framepost/facebook');
  console.log(`Found ${fbAssets.length} assets in Framepost/facebook`);
  if (fbAssets.length > 0) {
    console.log('Sample:');
    fbAssets.slice(0, 3).forEach((a) =>
      console.log(`  - ${a.public_id} (current tags: ${safeTags(a)})`)
    );
    await tagBatch(
      fbAssets.map((a) => a.public_id),
      'facebook'
    );
  }

  console.log('\n=== Done ===');
  console.log(`Total IG: ${igAssets.length}, Total FB: ${fbAssets.length}`);
})().catch((err) => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
