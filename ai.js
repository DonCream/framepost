// ai.js - caption generation, Ollama vision-first with OpenRouter fallback
const axios = require('axios');

const SYSTEM_PROMPT = `You write captions for a Detroit-based portrait and street documentary photographer (WebJelly Studios). Captions are short (1-3 sentences), evocative, in the photographer's voice — observational, grounded, never corny. Do not use emoji. Do not use hashtags. Do not start with "Captured" or "In this shot". Just write the caption — no preamble, no explanation.`;

// Download an image URL and return it as base64 (no data: prefix — Ollama wants raw base64)
async function fetchImageAsBase64(imageUrl) {
  const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data).toString('base64');
}

async function captionFromOllama(imageUrl, extraGuidance = '') {
  const url = `${process.env.OLLAMA_URL}/api/chat`;
  const imageB64 = await fetchImageAsBase64(imageUrl);

  const userText = extraGuidance
    ? `Write a caption for this photograph. ${extraGuidance}`
    : 'Write a caption for this photograph.';

  const res = await axios.post(
    url,
    {
      model: process.env.OLLAMA_MODEL || 'gemma4:e4b',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: userText,
          images: [imageB64], // Ollama expects raw base64 strings here
        },
      ],
      stream: false,
      options: { temperature: 0.8 },
    },
    { timeout: 120000 }
  );

  // Strip any Gemma "thinking" tags that might leak through
  let text = (res.data?.message?.content || '').trim();
  text = text.replace(/<\|channel\|>thought[\s\S]*?<channel\|>/g, '').trim();
  text = text.replace(/<\|think\|>/g, '').trim();
  return text;
}

async function captionFromOpenRouter(imageUrl, extraGuidance = '') {
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: extraGuidance
                ? `Write a caption for this photograph. ${extraGuidance}`
                : 'Write a caption for this photograph.',
            },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      max_tokens: 200,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );
  return res.data.choices[0].message.content.trim();
}

async function generateCaption(imageUrl, extraGuidance = '') {
  // Try Ollama vision first
  try {
    const c = await captionFromOllama(imageUrl, extraGuidance);
    if (c && c.length > 10) return { caption: c, source: 'ollama' };
    console.warn('Ollama returned empty/short caption, falling back');
  } catch (err) {
    console.warn('Ollama failed, falling back to OpenRouter:', err.message);
  }

  // Fallback to OpenRouter (only if API key is set)
  if (!process.env.OPENROUTER_API_KEY) {
    return { caption: '', source: 'failed', error: 'Ollama failed and no OpenRouter key set' };
  }

  try {
    const c = await captionFromOpenRouter(imageUrl, extraGuidance);
    return { caption: c, source: 'openrouter' };
  } catch (err) {
    console.error('OpenRouter also failed:', err.message);
    return { caption: '', source: 'failed', error: err.message };
  }
}

module.exports = { generateCaption };
