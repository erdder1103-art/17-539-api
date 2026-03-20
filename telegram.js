const fetch = require('node-fetch');
const { readBotConfig } = require('./botConfigStore');

function splitChatIds(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map(s => String(s || '').trim())
    .filter(Boolean);
}

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

function assertBotToken() {
  const { token } = getBotConfig();
  if (!token) throw new Error('缺少 BOT_TOKEN 環境變數或伺服器已儲存設定');
  return token;
}

async function callTelegram(method, payload = {}, options = {}) {
  const token = assertBotToken();
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
  const { chatId: defaultChatId } = assertBotConfig();
  const chatId = String(options.chatId || defaultChatId || '').trim();
  if (!chatId) throw new Error('缺少可發送的 chat_id');
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_to_message_id: options.replyToMessageId || undefined,
    allow_sending_without_reply: options.replyToMessageId ? true : undefined
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

async function callTelegramMultipart(method, formData, options = {}) {
  const token = assertBotToken();
  const timeoutMs = Number(options.timeoutMs || process.env.TG_TIMEOUT_MS || 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://api.telegram.org/bot${token}/${method}`;
  try {
    const res = await global.fetch(url, {
      method: 'POST',
      body: formData,
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.description || `Telegram HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Telegram timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function sendTelegramMedia(options = {}) {
  const { chatId: defaultChatId } = assertBotConfig();
  const chatId = String(options.chatId || defaultChatId || '').trim();
  if (!chatId) throw new Error('缺少可發送的 chat_id');
  const file = options.file || null;
  if (!file || !file.dataUrl) {
    return sendTelegramMessage(String(options.text || '').trim(), options);
  }
  const type = String(file.type || '').toLowerCase();
  const base64 = String(file.dataUrl || '').split(',').pop();
  if (!base64) throw new Error('附件資料格式不正確');
  const buffer = Buffer.from(base64, 'base64');
  const blob = new Blob([buffer], { type: file.type || 'application/octet-stream' });
  const form = new FormData();
  let method = 'sendDocument';
  let field = 'document';
  let textField = 'caption';
  if (type.startsWith('image/')) { method = 'sendPhoto'; field = 'photo'; }
  else if (type.startsWith('video/')) { method = 'sendVideo'; field = 'video'; }
  form.append('chat_id', chatId);
  if (options.text) form.append(textField, String(options.text));
  form.append(field, blob, file.name || 'upload');
  return callTelegramMultipart(method, form, options);
}

async function broadcastTelegramMessage(options = {}) {
  const { chatId: defaultChatId } = assertBotConfig();
  const targets = options.toAll ? splitChatIds(defaultChatId) : splitChatIds(options.chatIds);
  if (!targets.length) throw new Error(options.toAll ? '請先設定 TG_CHAT_ID' : '請輸入至少一個 chat_id');
  const results = [];
  for (const chatId of targets) {
    const data = options.file && options.file.dataUrl
      ? await sendTelegramMedia({ chatId, text: options.text, file: options.file, timeoutMs: options.timeoutMs })
      : await sendTelegramMessage(String(options.text || '').trim(), { chatId, timeoutMs: options.timeoutMs });
    results.push({
      ok: true,
      chatId,
      messageId: data && data.result ? data.result.message_id : null
    });
  }
  return { ok: true, targets: results, count: results.length };
}

module.exports = {
  callTelegram,
  callTelegramMultipart,
  sendTelegramMessage,
  sendTelegramMedia,
  broadcastTelegramMessage,
  splitChatIds,
  getBotConfig,
  getBotRuntimeSummary,
  assertBotConfig,
  assertBotToken,
  testTelegramSend
};
