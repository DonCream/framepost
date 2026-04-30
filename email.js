// email.js - send review emails with action buttons (single image)
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function platformBadge(platform) {
  const color = platform === 'instagram' ? '#E1306C' : '#1877F2';
  const label = platform === 'instagram' ? 'INSTAGRAM' : 'FACEBOOK';
  return `<span style="display:inline-block;padding:4px 12px;background:${color};color:white;border-radius:12px;font-size:11px;font-weight:600;letter-spacing:0.5px;">${label}</span>`;
}

function buildReviewHtml({ token, url, platform, caption, hashtagSets }) {
  const base = process.env.PUBLIC_URL;
  const tagPills = hashtagSets
    .map((s) => `<span style="display:inline-block;background:#eef;padding:2px 8px;border-radius:10px;margin:2px;font-size:12px;">${s}</span>`)
    .join('');

  return `
  <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:16px;">
    <h2 style="margin:0 0 12px;">FramePost — Ready for Review</h2>
    <div style="margin-bottom:8px;">${platformBadge(platform)}</div>

    <img src="${url}" style="width:100%;border-radius:8px;margin-bottom:12px;" />

    <div style="background:#f6f6f6;padding:12px;border-radius:8px;margin-bottom:8px;white-space:pre-wrap;">${caption}</div>
    <div style="margin-bottom:16px;">${tagPills}</div>

    <div style="display:flex;flex-direction:column;gap:8px;">
      <a href="${base}/review/${token}/approve"
         style="display:block;background:#1a7f3c;color:#fff;text-decoration:none;padding:14px;border-radius:8px;text-align:center;font-weight:600;">
        ✓ Approve & Add to Queue
      </a>
      <a href="${base}/review/${token}/regenerate"
         style="display:block;background:#3b5fa0;color:#fff;text-decoration:none;padding:14px;border-radius:8px;text-align:center;font-weight:600;">
        ↻ Regenerate Caption
      </a>
      <a href="${base}/review/${token}/postnow"
         style="display:block;background:#a03b3b;color:#fff;text-decoration:none;padding:14px;border-radius:8px;text-align:center;font-weight:600;">
        ⚡ Post Now
      </a>
      <a href="${base}/review/${token}/skip"
         style="display:block;background:#666;color:#fff;text-decoration:none;padding:14px;border-radius:8px;text-align:center;font-weight:600;">
        ✕ Skip
      </a>
    </div>

    <p style="font-size:11px;color:#999;margin-top:16px;text-align:center;">
      Manage queue → <a href="${base}/queue">${base}/queue</a>
    </p>
  </div>`;
}

async function sendReviewEmail(payload) {
  return transporter.sendMail({
    from: process.env.REVIEW_EMAIL_FROM,
    to: process.env.REVIEW_EMAIL_TO,
    subject: `FramePost: Review ${payload.platform} — "${payload.caption.slice(0, 40)}…"`,
    html: buildReviewHtml(payload),
  });
}

module.exports = { sendReviewEmail };
