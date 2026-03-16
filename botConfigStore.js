const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const BOT_CONFIG_FILE = path.join(DATA_DIR, 'bot_config.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readBotConfig() {
  ensureDir();
  if (!fs.existsSync(BOT_CONFIG_FILE)) return { botToken: '', chatId: '', updatedAt: '' };
  try {
    const raw = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8'));
    return {
      botToken: String(raw.botToken || '').trim(),
      chatId: String(raw.chatId || '').trim(),
      updatedAt: String(raw.updatedAt || '').trim()
    };
  } catch (err) {
    return { botToken: '', chatId: '', updatedAt: '' };
  }
}

function writeBotConfig(input = {}) {
  ensureDir();
  const data = {
    botToken: String(input.botToken || '').trim(),
    chatId: String(input.chatId || '').trim(),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

module.exports = { readBotConfig, writeBotConfig, BOT_CONFIG_FILE };
