// ai.js - caption generation, Ollama vision-first with OpenRouter fallback
// Now supports both single-image and multi-image (carousel) captions.
const axios = require('axios');

const SINGLE_PROMPT = `You write captions for a Detroit-based portrait and street documentary photographer (WebJelly Studios). Captions are short (1-3 sentences), evocative, in the photographer's voice — observational, grounded, never corny. Do not use emoji. Do not use hashtags. Do not start with "Captured" or "In this shot". Just write the caption — no preamble, no explanation.`;

const CAROUSEL_PROMPT = `You write captions for a Detroit-based portrait and street documentary photographer (WebJelly Studios). The images you are about to see are a single sequential post (a carousel) — not separate photos. Write ONE caption that ties them together as a connected set, recognizing the shared mood, subject, story, or session that links them. Keep it short (1-3 sentences), evocative, observational, grounded, in the photographer's voice. No emoji. No hashtags. No preamble. Just the caption.`;

// Download an image URL and return it as base64 (no data: prefix — Ollama wants raw base64)
async function fetchImageAsBase64(imageUrl) {
  const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data).toString('base64');
}

// Strip any leaking <think>…</think> blocks some models emit
function cleanCaption(s) {
  if (!s) return '';
  return s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ---------- Ollama ----------

async function captionFromOllama(imageUrls, extraGuidance = '') {
  const url = `${process.env.OLLAMA_URL}/api/chat`;
  const isCarousel = imageUrls.length > 1;

  // Fetch all images in parallel
  const imagesB64 = await Promise.all(imageUrls.map(fetchImageAsBase64));

  const baseText = isCarousel
    ? 'Write one caption for these photographs as a connected set.'
    : 'Write a caption for this photograph.';
  const userText = extraGuidance ? `${baseText} ${extraGuidance}` : baseText;

  const res = await axios.post(
    url,
    {
      model: process.env.OLLAMA_MODEL || 'gemma4:e4b',
      stream: false,
      messages: [
        { role: 'system', content: isCarousel ? CAROUSEL_PROMPT : SINGLE_PROMPT },
        { role: 'user', content: userText, images: imagesB64 },
      ],
      options: { temperature: 0.7 },
    },
    { timeout: 120000 } // multi-image vision is slower; bumped to 2 min
  );

  return cleanCaption(res.data?.message?.content || '');
}

// ---------- OpenRouter fallback ----------

async function captionFromOpenRouter(imageUrls, extraGuidance = '') {
  const isCarousel = imageUrls.length > 1;
  const baseText = isCarousel
    ? 'Write one caption for these photographs as a connected set.'
    : 'Write a caption for this photograph.';
  const userText = extraGuidance ? `${baseText} ${extraGuidance}` : baseText;

  // Build content array: text first, then all images
  const content = [{ type: 'text', text: userText }];
  for (const u of imageUrls) {
    content.push({ type: 'image_url', image_url: { url: u } });
  }

  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: isCarousel ? CAROUSEL_PROMPT : SINGLE_PROMPT },
        { role: 'user', content },
      ],
      max_tokens: 200,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 90000,
    }
  );
  return cleanCaption(res.data.choices[0].message.content || '');
}

// ---------- public API ----------

// Accepts a single URL string OR an array of URLs (1-10).
async function generateCaption(imageInput, extraGuidance = '') {
  const imageUrls = Array.isArray(imageInput) ? imageInput : [imageInput];
  if (imageUrls.length === 0) {
    return { caption: '', source: 'failed', error: 'no images provided' };
  }
  if (imageUrls.length > 10) {
    return { caption: '', source: 'failed', error: 'too many images (max 10)' };
  }

  // Try Ollama vision first
  try {
    const c = await captionFromOllama(imageUrls, extraGuidance);
    if (c && c.length > 10) return { caption: c, source: 'ollama' };
    console.warn('Ollama returned empty/short caption, falling back');
  } catch (err) {
    console.warn('Ollama failed, falling back to OpenRouter:', err.message);
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return { caption: '', source: 'failed', error: 'Ollama failed and no OpenRouter key set' };
  }

  try {
    const c = await captionFromOpenRouter(imageUrls, extraGuidance);
    return { caption: c, source: 'openrouter' };
  } catch (err) {
    console.error('OpenRouter also failed:', err.message);
    return { caption: '', source: 'failed', error: err.message };
  }
}

module.exports = { generateCaption };
