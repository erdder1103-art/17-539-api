
const fetch = require('node-fetch');

function getBotConfig() {
  const token =
    process.env.BOT_TOKEN ||
    "8724288146:AAFUItEZqR_jWTn6vr3xCxEM-3Bg_9y2gMY";

  const chatId =
    process.env.TG_CHAT_ID ||
    "-5292559147";

  return { token, chatId };
}

async function sendTelegramMessage(text) {
  const { token, chatId } = getBotConfig();
  if (!token) throw new Error('缺少 BOT_TOKEN');
  if (!chatId) throw new Error('缺少 TG_CHAT_ID');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  console.log("Sending TG message:", text);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.description || `Telegram HTTP ${res.status}`);
  }
  return data;
}

module.exports = { sendTelegramMessage };
