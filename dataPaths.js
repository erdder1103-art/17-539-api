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

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function migrateLocalDataIfNeeded() {
  if (ACTIVE_DATA_DIR === LOCAL_DATA_DIR) return { migrated: false, reason: 'using-local-data-dir' };
  try {
    fs.mkdirSync(ACTIVE_DATA_DIR, { recursive: true });
    if (!fs.existsSync(LOCAL_DATA_DIR)) return { migrated: false, reason: 'no-local-data-dir' };

    const localFiles = fs.readdirSync(LOCAL_DATA_DIR).filter((name) => fs.statSync(path.join(LOCAL_DATA_DIR, name)).isFile());
    if (!localFiles.length) return { migrated: false, reason: 'no-local-files' };

    const volumeFiles = fs.existsSync(ACTIVE_DATA_DIR)
      ? fs.readdirSync(ACTIVE_DATA_DIR).filter((name) => fs.statSync(path.join(ACTIVE_DATA_DIR, name)).isFile())
      : [];
    if (volumeFiles.length) return { migrated: false, reason: 'volume-already-has-files' };

    let copied = 0;
    for (const name of localFiles) {
      const src = path.join(LOCAL_DATA_DIR, name);
      const dest = path.join(ACTIVE_DATA_DIR, name);
      fs.copyFileSync(src, dest);
      copied += 1;
    }
    return { migrated: copied > 0, copied, source: LOCAL_DATA_DIR, target: ACTIVE_DATA_DIR };
  } catch (err) {
    return { migrated: false, reason: 'migration-error', error: err.message };
  }
}

module.exports = {
  LOCAL_DATA_DIR,
  DEFAULT_VOLUME_DIR,
  ACTIVE_DATA_DIR,
  getDataDir,
  getDataFile,
  readJsonSafe,
  migrateLocalDataIfNeeded
};
