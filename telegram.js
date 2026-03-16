const fetch = require('node-fetch');
const { readBotConfig } = require('./botConfigStore');

function getBotConfig() {
  const envToken = String(process.env.BOT_TOKEN || '').trim();
  const envChatId = String(process.env.TG_CHAT_ID || '').trim();
  const fileCfg = readBotConfig();
  const token = envToken || String(fileCfg.botToken || '').trim();
  const chatId = envChatId || String(fileCfg.chatId || '').trim();
  return {
    token,
    chatId,
    source: {
      token: envToken ? 'env' : (fileCfg.botToken ? 'file' : 'missing'),
      chatId: envChatId ? 'env' : (fileCfg.chatId ? 'file' : 'missing')
    }
  };
}

function maskMiddle(value, head = 6, tail = 4) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= head + tail) return `${s.slice(0, Math.max(1, head))}***`;
  return `${s.slice(0, head)}***${s.slice(-tail)}`;
}

function getBotRuntimeSummary() {
  const { token, chatId, source } = getBotConfig();
  return {
    hasBotToken: Boolean(token),
    hasChatId: Boolean(chatId),
    botTokenLength: token.length,
    chatIdPreview: maskMiddle(chatId, 4, 2),
    tokenSource: source.token,
    chatIdSource: source.chatId,
    runtimeSeenAt: new Date().toISOString()
  };
}

function assertBotConfig() {
  const { token, chatId } = getBotConfig();
  if (!token) throw new Error('缺少 BOT_TOKEN 環境變數或伺服器已儲存設定');
  if (!chatId) throw new Error('缺少 TG_CHAT_ID 環境變數或伺服器已儲存設定');
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
