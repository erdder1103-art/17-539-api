const fetch = require('node-fetch');

function getBotConfig() {
  const token = String(process.env.BOT_TOKEN || '').trim();
  const chatId = String(process.env.TG_CHAT_ID || '').trim();
  return { token, chatId };
}

function maskMiddle(value, head = 6, tail = 4) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= head + tail) return `${s.slice(0, Math.max(1, head))}***`;
  return `${s.slice(0, head)}***${s.slice(-tail)}`;
}

function getBotRuntimeSummary() {
  const { token, chatId } = getBotConfig();
  return {
    hasBotToken: Boolean(token),
    hasChatId: Boolean(chatId),
    botTokenLength: token.length,
    chatIdPreview: maskMiddle(chatId, 4, 2),
    runtimeSeenAt: new Date().toISOString()
  };
}

function assertBotConfig() {
  const { token, chatId } = getBotConfig();
  if (!token) throw new Error('缺少 BOT_TOKEN 環境變數');
  if (!chatId) throw new Error('缺少 TG_CHAT_ID 環境變數');
  return { token, chatId };
}

async function callTelegram(method, payload = {}, options = {}) {
  const { token } = assertBotConfig();
  const timeoutMs = Number(options.timeoutMs || process.env.TG_TIMEOUT_MS || 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://api.telegram.org/bot${token}/${method}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

async function sendTelegramMessage(text, options = {}) {
  const { chatId } = assertBotConfig();
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  }, options);
}

async function testTelegramSend(text = 'Telegram 測試成功') {
  const result = await sendTelegramMessage(text, { timeoutMs: 8000 });
  return {
    ok: true,
    chatId: result.result && result.result.chat ? result.result.chat.id : null,
    messageId: result.result ? result.result.message_id : null
  };
}

module.exports = {
  sendTelegramMessage,
  getBotConfig,
  getBotRuntimeSummary,
  assertBotConfig,
  testTelegramSend
};
