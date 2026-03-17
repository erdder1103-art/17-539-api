const { getDataFile, initializeDataFiles, readJsonSafe, writeJsonAtomic } = require('./dataPaths');

const BOT_CONFIG_FILE = getDataFile('bot_config.json');

function ensureStore() {
  initializeDataFiles();
}

function readBotConfig() {
  ensureStore();
  try {
    const raw = readJsonSafe(BOT_CONFIG_FILE, { botToken: '', chatId: '', updatedAt: '' });
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
  ensureStore();
  const data = {
    botToken: String(input.botToken || '').trim(),
    chatId: String(input.chatId || '').trim(),
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(BOT_CONFIG_FILE, data);
  return data;
}

module.exports = { readBotConfig, writeBotConfig, BOT_CONFIG_FILE };
