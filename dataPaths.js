const fs = require('fs');
const path = require('path');

const LOCAL_DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_VOLUME_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';

function canUseDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (err) {
    return false;
  }
}

const ACTIVE_DATA_DIR = canUseDir(DEFAULT_VOLUME_DIR) ? DEFAULT_VOLUME_DIR : LOCAL_DATA_DIR;

function getDataDir() {
  return ACTIVE_DATA_DIR;
}

function getDataFile(name) {
  return path.join(ACTIVE_DATA_DIR, name);
}

function ensureDir(dir = ACTIVE_DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, data) {
  writeTextAtomic(file, JSON.stringify(data, null, 2));
}

const DEFAULT_FILE_CONTENTS = {
  'tracking.json': { '539': { system: null, manuals: [] }, 'ttl': { system: null, manuals: [] } },
  'tracking_history.json': [],
  'result_history.json': [],
  'result_state.json': { '539': { processedIssues: [] }, 'ttl': { processedIssues: [] } },
  'learning_state.json': { '539': { system: { total: 0, labels: {}, lessons: {} } }, 'ttl': { system: { total: 0, labels: {}, lessons: {} } } },
  'weekly_stats.json': { '539': null, 'ttl': null },
  'bot_config.json': { botToken: '', chatId: '', updatedAt: '' }
};

function initializeDataFiles() {
  ensureDir(ACTIVE_DATA_DIR);
  const created = [];
  for (const [name, initialValue] of Object.entries(DEFAULT_FILE_CONTENTS)) {
    const file = getDataFile(name);
    if (!fs.existsSync(file)) {
      writeJsonAtomic(file, initialValue);
      created.push(name);
    }
  }
  return {
    initialized: true,
    created,
    target: ACTIVE_DATA_DIR,
    usedVolume: ACTIVE_DATA_DIR === DEFAULT_VOLUME_DIR
  };
}

function getStorageDebug() {
  const files = {};
  for (const name of Object.keys(DEFAULT_FILE_CONTENTS)) {
    const volFile = getDataFile(name);
    const localFile = path.join(LOCAL_DATA_DIR, name);
    const describe = (file) => {
      try {
        if (!fs.existsSync(file)) return { exists: false };
        const stat = fs.statSync(file);
        const raw = fs.readFileSync(file, 'utf8');
        return { exists: true, size: stat.size, mtime: stat.mtime.toISOString(), preview: raw.slice(0, 120) };
      } catch (err) {
        return { exists: false, error: err.message };
      }
    };
    files[name] = { active: describe(volFile), local: describe(localFile) };
  }
  return {
    dataDir: ACTIVE_DATA_DIR,
    defaultVolumeDir: DEFAULT_VOLUME_DIR,
    localDataDir: LOCAL_DATA_DIR,
    volumeMounted: ACTIVE_DATA_DIR === DEFAULT_VOLUME_DIR,
    files
  };
}

module.exports = {
  LOCAL_DATA_DIR,
  DEFAULT_VOLUME_DIR,
  ACTIVE_DATA_DIR,
  getDataDir,
  getDataFile,
  ensureDir,
  readJsonSafe,
  writeJsonAtomic,
  initializeDataFiles,
  getStorageDebug
};
