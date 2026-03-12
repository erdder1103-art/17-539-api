const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const TRACKING_FILE = path.join(DATA_DIR, 'tracking.json');
const HISTORY_FILE = path.join(DATA_DIR, 'tracking_history.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureFile(file, fallback) {
  ensureDir();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8');
  }
}

function readJson(file, fallback) {
  ensureFile(file, fallback);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeLotteryType(lotteryType) {
  return lotteryType === 'ttl' ? 'ttl' : '539';
}

function getTrackingMap() {
  return readJson(TRACKING_FILE, { '539': null, 'ttl': null });
}

function saveTrackingMap(map) {
  writeJson(TRACKING_FILE, map);
}

function appendHistory(entry) {
  const history = readJson(HISTORY_FILE, []);
  history.push(entry);
  writeJson(HISTORY_FILE, history);
}

function getActiveTracking(lotteryType) {
  const map = getTrackingMap();
  return map[normalizeLotteryType(lotteryType)] || null;
}

function cancelActiveTracking(lotteryType) {
  const key = normalizeLotteryType(lotteryType);
  const map = getTrackingMap();
  const current = map[key];
  if (!current) return null;

  const cancelled = {
    ...current,
    status: 'cancelled',
    cancelledAt: new Date().toISOString()
  };
  appendHistory(cancelled);
  map[key] = null;
  saveTrackingMap(map);
  return cancelled;
}

function setActiveTracking(lotteryType, tracking) {
  const key = normalizeLotteryType(lotteryType);
  const map = getTrackingMap();
  map[key] = tracking;
  saveTrackingMap(map);
  appendHistory({ ...tracking, event: 'created' });
  return tracking;
}

module.exports = {
  getActiveTracking,
  cancelActiveTracking,
  setActiveTracking,
  normalizeLotteryType
};
