const fetch = require('node-fetch');

function getBotConfig() {
  const token = String(process.env.BOT_TOKEN || '').trim();
  const chatId = String(process.env.TG_CHAT_ID || '').trim();
  return { token, chatId };
}

function assertBotConfig() {
  const { token, chatId } = getBotConfig();
  if (!token) throw new Error('缺少 BOT_TOKEN 環境變數');
  if (!chatId) throw new Error('缺少 TG_CHAT_ID 環境變數');
  return { token, chatId };
}

async function sendTelegramMessage(text, options = {}) {
  const { token, chatId } = assertBotConfig();
  const timeoutMs = Number(options.timeoutMs || process.env.TG_TIMEOUT_MS || 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.description || `Telegram HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Telegram timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendTelegramMessage, getBotConfig, assertBotConfig };
