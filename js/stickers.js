// Stickers: emoji drawn with the phone's own emoji font, plus a few simple shapes drawn by this bot.
export const EMOJI = '😀 😂 🤣 😍 🥰 😎 🤩 🥳 😭 😱 🤯 😴 🙄 🤔 🫶 👍 👏 🙌 💪 🔥 ✨ 💯 ❤️ 💔 💥 ⭐ 🌟 ⚡ 🎉 🎂 🎵 📸 🎬 🏆 ⚽ 🏀 🚗 ✈️ 🌴 🌊 ☀️ 🌙 🍕 🍔 ☕ 🐶 🐱 👀 👉 👇 ✅ ❌ ⁉️ 💬 📍'.split(' ');
// Bot-made SVG stickers (made by your bot for this app; free to use).
const svg = (body, w = 400, h = 400) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;
export const BOT_STICKERS = [
  { name: 'Arrow', madeBy: 'bot', svg: svg('<path d="M30 200h250l-70-70 30-30 120 120-120 120-30-30 70-70H30z" fill="#ffd43b" stroke="#000" stroke-width="12" stroke-linejoin="round"/>') },
  { name: 'Circle', madeBy: 'bot', svg: svg('<circle cx="200" cy="200" r="160" fill="none" stroke="#ff2d55" stroke-width="22"/>') },
  { name: 'Burst', madeBy: 'bot', svg: svg('<polygon points="200,20 238,130 350,90 285,190 380,250 265,265 280,380 200,300 120,380 135,265 20,250 115,190 50,90 162,130" fill="#ff6b00" stroke="#000" stroke-width="10" stroke-linejoin="round"/>') },
  { name: 'NEW tag', madeBy: 'bot', svg: svg('<rect x="20" y="110" width="360" height="180" rx="40" fill="#ff2d55" stroke="#fff" stroke-width="14"/><text x="200" y="232" font-family="Impact, Arial Black, sans-serif" font-weight="900" font-size="120" text-anchor="middle" fill="#fff">NEW</text>') },
  { name: 'Speech', madeBy: 'bot', svg: svg('<path d="M60 60h280a30 30 0 0 1 30 30v170a30 30 0 0 1-30 30H170l-80 70v-70H60a30 30 0 0 1-30-30V90a30 30 0 0 1 30-30z" fill="#fff" stroke="#000" stroke-width="12"/>') },
  { name: 'Underline', madeBy: 'bot', svg: svg('<path d="M20 230 C120 180, 280 270, 380 200" fill="none" stroke="#ffd43b" stroke-width="28" stroke-linecap="round"/>', 400, 400) },
];
// Render an SVG sticker to a PNG blob (fonts already loaded by the page).
export async function stickerPng(s) {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.svg); await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
