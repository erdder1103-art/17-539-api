const crypto = require('crypto');
const { getDataFile, readJsonSafe, writeJsonAtomic } = require('./dataPaths');

const FILE = getDataFile('members.json');
const DEFAULT_ADMIN_USERNAME = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin12345';
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 7);

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makePasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    salt,
    hash: hashPassword(password, salt)
  };
}

function verifyPassword(password, record = {}) {
  if (!record.salt || !record.hash) return false;
  const actual = hashPassword(password, record.salt);
  const expected = Buffer.from(record.hash, 'hex');
  const actualBuf = Buffer.from(actual, 'hex');
  return expected.length === actualBuf.length && crypto.timingSafeEqual(expected, actualBuf);
}

function defaultStore() {
  const adminPassword = makePasswordRecord(DEFAULT_ADMIN_PASSWORD);
  return {
    users: [
      {
        id: 'u_admin',
        username: DEFAULT_ADMIN_USERNAME,
        role: 'admin',
        displayName: '管理員',
        password: adminPassword,
        status: 'active',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        note: '首次部署預設帳號，請登入後盡快修改。'
      }
    ],
    sessions: []
  };
}

function loadStore() {
  const fallback = defaultStore();
  const store = readJsonSafe(FILE, fallback);
  if (!Array.isArray(store.users) || !store.users.length) {
    writeJsonAtomic(FILE, fallback);
    return fallback;
  }
  if (!Array.isArray(store.sessions)) store.sessions = [];
  cleanupExpiredSessions(store);
  return store;
}

function saveStore(store) {
  cleanupExpiredSessions(store);
  writeJsonAtomic(FILE, store);
}

function cleanupExpiredSessions(store) {
  const now = Date.now();
  store.sessions = (Array.isArray(store.sessions) ? store.sessions : []).filter(s => {
    if (!s || !s.expiresAt || !s.tokenHash) return false;
    return new Date(s.expiresAt).getTime() > now;
  });
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName || user.username,
    status: user.status || 'active',
    createdAt: user.createdAt || '',
    updatedAt: user.updatedAt || ''
  };
}

function loginMember(username, password) {
  const store = loadStore();
  const normalized = String(username || '').trim().toLowerCase();
  const user = store.users.find(u => String(u.username || '').toLowerCase() === normalized);
  if (!user || user.status === 'disabled') throw new Error('帳號或密碼錯誤');
  if (!verifyPassword(password, user.password)) throw new Error('帳號或密碼錯誤');
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  store.sessions.push({
    tokenHash,
    userId: user.id,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  });
  saveStore(store);
  return {
    token,
    user: sanitizeUser(user),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    isDefaultAdmin: String(user.username) === DEFAULT_ADMIN_USERNAME
  };
}

function findUserByToken(token) {
  if (!token) return null;
  const store = loadStore();
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const session = store.sessions.find(s => s.tokenHash === tokenHash);
  if (!session) return null;
  const user = store.users.find(u => u.id === session.userId && u.status !== 'disabled');
  if (!user) return null;
  return {
    user: sanitizeUser(user),
    session: {
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    }
  };
}

function logoutMember(token) {
  if (!token) return false;
  const store = loadStore();
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const before = store.sessions.length;
  store.sessions = store.sessions.filter(s => s.tokenHash !== tokenHash);
  if (store.sessions.length !== before) saveStore(store);
  return store.sessions.length !== before;
}

function getMemberBootstrapInfo() {
  const store = loadStore();
  const admin = store.users.find(u => u.username === DEFAULT_ADMIN_USERNAME) || store.users[0];
  return {
    initialized: true,
    defaultUsername: admin?.username || DEFAULT_ADMIN_USERNAME,
    hasUsers: Array.isArray(store.users) && store.users.length > 0
  };
}

module.exports = {
  loginMember,
  findUserByToken,
  logoutMember,
  getMemberBootstrapInfo
};
