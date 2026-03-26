const crypto = require('crypto');
const { getDataFile, readJsonSafe, writeJsonAtomic } = require('./dataPaths');

const FILE = getDataFile('members.json');
const DEFAULT_ADMIN_USERNAME = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin12345';
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 7);
const DEFAULT_DEVICE_LIMIT = Number(process.env.MEMBER_DEVICE_LIMIT || 3);
const ALLOWED_DEVICE_LIMITS = [3, 5, 8, 10];

const PLAN_DAYS = {
  key: 30,
  month: 30,
  quarter: 90,
  year: 365,
  custom: 0,
  permanent: 36500
};

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makePasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, record = {}) {
  if (!record.salt || !record.hash) return false;
  const actual = hashPassword(password, record.salt);
  const expected = Buffer.from(record.hash, 'hex');
  const actualBuf = Buffer.from(actual, 'hex');
  return expected.length === actualBuf.length && crypto.timingSafeEqual(expected, actualBuf);
}

function addDays(baseDate, days) {
  const dt = new Date(baseDate || Date.now());
  dt.setDate(dt.getDate() + Number(days || 0));
  return dt.toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function makeAccessKeyString(prefix = 'SVN') {
  const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `${prefix}-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function normalizePlan(planType, durationDays) {
  const type = String(planType || 'month').toLowerCase();
  const fallback = PLAN_DAYS[type] ?? PLAN_DAYS.month;
  const days = type === 'custom' ? Math.max(1, Number(durationDays || 0)) : fallback;
  return { planType: type, durationDays: days };
}

function buildExpiry(planType, durationDays, currentExpiresAt) {
  const { planType: normalizedPlan, durationDays: days } = normalizePlan(planType, durationDays);
  const anchor = currentExpiresAt && new Date(currentExpiresAt).getTime() > Date.now() ? currentExpiresAt : nowIso();
  const expiresAt = normalizedPlan === 'permanent' ? '2999-12-31T23:59:59.000Z' : addDays(anchor, days);
  return { planType: normalizedPlan, durationDays: days, expiresAt };
}

function isExpired(user) {
  if (!user?.expiresAt) return false;
  return new Date(user.expiresAt).getTime() <= Date.now();
}

function sanitizeDevice(device) {
  if (!device) return null;
  return {
    id: device.id,
    userId: device.userId,
    deviceName: device.deviceName || '',
    userAgent: device.userAgent || '',
    firstLoginAt: device.firstLoginAt || '',
    lastSeenAt: device.lastSeenAt || '',
    lastIp: device.lastIp || '',
    status: device.status || 'active'
  };
}

function sanitizeUser(user, store) {
  if (!user) return null;
  const devices = getUserDevices(store, user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName || user.username,
    status: user.status || 'active',
    createdAt: user.createdAt || '',
    updatedAt: user.updatedAt || '',
    expiresAt: user.expiresAt || '',
    planType: user.planType || 'month',
    durationDays: Number(user.durationDays || 0),
    note: user.note || '',
    accessLevel: user.accessLevel || (user.role === 'admin' ? 'vip' : 'normal'),
    lastLoginAt: user.lastLoginAt || '',
    isExpired: isExpired(user),
    accessKeyId: user.accessKeyId || '',
    deviceLimit: Number(user.deviceLimit || DEFAULT_DEVICE_LIMIT),
    deviceCount: devices.length,
    devices
  };
}

function sanitizeKey(key) {
  if (!key) return null;
  return {
    id: key.id,
    code: key.code,
    planType: key.planType,
    durationDays: key.durationDays,
    status: key.status,
    createdAt: key.createdAt,
    usedAt: key.usedAt || '',
    usedBy: key.usedBy || '',
    note: key.note || ''
  };
}

function describeIp(ip = '') {
  const v = String(ip || '').trim();
  if (!v) return '未知來源';
  if (v === '::1' || v === '127.0.0.1' || v.startsWith('127.') || v === '::ffff:127.0.0.1' || v.startsWith('::ffff:127.')) return '本機 localhost';
  if (v.startsWith('192.168.') || v.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(v)) return '內網 / 區域網路';
  if (v.includes(':')) return 'IPv6 網路';
  return '外部網路';
}

function sanitizeAdminLog(item) {
  if (!item) return null;
  return {
    id: item.id,
    action: item.action || '',
    actor: item.actor || '',
    target: item.target || '',
    detail: item.detail || '',
    createdAt: item.createdAt || ''
  };
}

function addAdminLog(store, adminUser, action, target, detail = '') {
  if (!Array.isArray(store.adminLogs)) store.adminLogs = [];
  store.adminLogs.unshift({
    id: randomId('log'),
    action,
    actor: adminUser?.username || 'system',
    target: String(target || '').trim(),
    detail: String(detail || '').trim(),
    createdAt: nowIso()
  });
  store.adminLogs = store.adminLogs.slice(0, 500);
}

function defaultStore() {
  const adminPassword = makePasswordRecord(DEFAULT_ADMIN_PASSWORD);
  const adminExpiry = buildExpiry('permanent', 0);
  return {
    users: [{
      id: 'u_admin',
      username: DEFAULT_ADMIN_USERNAME,
      role: 'admin',
      displayName: '系統管理員',
      password: adminPassword,
      status: 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      note: '首次部署預設帳號，請登入後盡快修改。',
      accessLevel: 'vip',
      deviceLimit: 99,
      ...adminExpiry
    }],
    sessions: [],
    accessKeys: [],
    devices: [],
    adminLogs: []
  };
}

function cleanupExpiredSessions(store) {
  const now = Date.now();
  store.sessions = (Array.isArray(store.sessions) ? store.sessions : []).filter(s => {
    if (!s || !s.expiresAt || !s.tokenHash) return false;
    return new Date(s.expiresAt).getTime() > now;
  });
}

function ensureStoreShape(store) {
  if (!Array.isArray(store.users)) store.users = [];
  if (!Array.isArray(store.sessions)) store.sessions = [];
  if (!Array.isArray(store.accessKeys)) store.accessKeys = [];
  if (!Array.isArray(store.devices)) store.devices = [];
  if (!Array.isArray(store.adminLogs)) store.adminLogs = [];
  if (!store.users.length) {
    const fallback = defaultStore();
    store.users = fallback.users;
  }
  store.users = store.users.map((user, idx) => {
    const next = { ...user };
    if (!next.id) next.id = idx === 0 ? 'u_admin' : randomId('u');
    if (!next.role) next.role = idx === 0 ? 'admin' : 'member';
    if (!next.displayName) next.displayName = next.username || `會員${idx + 1}`;
    if (!next.createdAt) next.createdAt = nowIso();
    if (!next.updatedAt) next.updatedAt = next.createdAt;
    if (!next.planType || next.durationDays === undefined || !next.expiresAt) {
      Object.assign(next, buildExpiry(next.role === 'admin' ? 'permanent' : 'month', next.role === 'admin' ? 0 : 30));
    }
    if (!next.deviceLimit) next.deviceLimit = next.role === 'admin' ? 99 : DEFAULT_DEVICE_LIMIT;
    if (!next.accessLevel) next.accessLevel = next.role === 'admin' ? 'vip' : 'normal';
    return next;
  });
  cleanupExpiredSessions(store);
  store.devices = store.devices.filter(d => d && d.id && d.userId).map(d => ({ status: 'active', ...d }));
  return store;
}

function loadStore() {
  const fallback = defaultStore();
  const store = ensureStoreShape(readJsonSafe(FILE, fallback));
  writeJsonAtomic(FILE, store);
  return store;
}

function saveStore(store) {
  ensureStoreShape(store);
  writeJsonAtomic(FILE, store);
}

function getUserByUsername(store, username) {
  const normalized = String(username || '').trim().toLowerCase();
  return store.users.find(u => String(u.username || '').trim().toLowerCase() === normalized) || null;
}

function getUserDevices(store, userId) {
  return (store?.devices || []).filter(d => d.userId === userId && d.status !== 'removed').map(sanitizeDevice);
}

function touchUserLogin(store, userId) {
  const user = store.users.find(u => u.id === userId);
  if (user) {
    user.lastLoginAt = nowIso();
    user.updatedAt = nowIso();
  }
}

function normalizeDeviceInfo(deviceInfo = {}, fallback = {}) {
  const deviceId = String(deviceInfo.deviceId || '').trim().slice(0, 120);
  return {
    deviceId,
    deviceName: String(deviceInfo.deviceName || fallback.deviceName || '未知設備').trim().slice(0, 120),
    userAgent: String(deviceInfo.userAgent || fallback.userAgent || '').trim().slice(0, 300),
    ip: String(deviceInfo.ip || fallback.ip || '').trim().slice(0, 80)
  };
}

function ensureMemberDevice(store, user, deviceInfo = {}) {
  if (!deviceInfo.deviceId || user.role === 'admin') return null;
  const currentTime = nowIso();
  let device = store.devices.find(d => d.userId === user.id && d.id === deviceInfo.deviceId && d.status !== 'removed');
  if (!device) {
    const activeDevices = store.devices.filter(d => d.userId === user.id && d.status !== 'removed');
    if (activeDevices.length >= Number(user.deviceLimit || DEFAULT_DEVICE_LIMIT)) {
      const err = new Error(`已超過綁定 ${Number(user.deviceLimit || DEFAULT_DEVICE_LIMIT)} 個設備，需聯繫管理員處理`);
      err.code = 'DEVICE_LIMIT_REACHED';
      throw err;
    }
    device = {
      id: deviceInfo.deviceId,
      userId: user.id,
      deviceName: deviceInfo.deviceName || '未知設備',
      userAgent: deviceInfo.userAgent || '',
      firstLoginAt: currentTime,
      lastSeenAt: currentTime,
      lastIp: deviceInfo.ip || '',
      status: 'active'
    };
    store.devices.push(device);
  } else {
    device.deviceName = deviceInfo.deviceName || device.deviceName || '未知設備';
    device.userAgent = deviceInfo.userAgent || device.userAgent || '';
    device.lastSeenAt = currentTime;
    device.lastIp = deviceInfo.ip || device.lastIp || '';
  }
  return sanitizeDevice(device);
}

function loginMember(username, password, deviceInfo = {}) {
  const store = loadStore();
  const user = getUserByUsername(store, username);
  if (!user) throw new Error('帳號不存在');
  if (user.status === 'disabled') throw new Error('帳號已停用，請通知管理員處理');
  if (isExpired(user)) throw new Error('會員使用期限已到，請通知管理員處理');
  if (!verifyPassword(password, user.password)) throw new Error('密碼錯誤');
  const normalizedDevice = normalizeDeviceInfo(deviceInfo);
  const boundDevice = ensureMemberDevice(store, user, normalizedDevice);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  store.sessions.push({
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    userId: user.id,
    deviceId: normalizedDevice.deviceId || '',
    createdAt: nowIso(),
    expiresAt
  });
  touchUserLogin(store, user.id);
  saveStore(store);
  return {
    token,
    user: sanitizeUser(user, store),
    expiresAt,
    isDefaultAdmin: String(user.username) === DEFAULT_ADMIN_USERNAME,
    device: boundDevice
  };
}

function findUserByToken(token, deviceInfo = {}) {
  if (!token) return null;
  const store = loadStore();
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const session = store.sessions.find(s => s.tokenHash === tokenHash);
  if (!session) return null;
  if (session.deviceId && deviceInfo?.deviceId && session.deviceId !== deviceInfo.deviceId) return null;
  const user = store.users.find(u => u.id === session.userId && u.status !== 'disabled');
  if (!user || isExpired(user)) return null;
  const normalizedDevice = normalizeDeviceInfo(deviceInfo);
  if (normalizedDevice.deviceId) {
    const device = store.devices.find(d => d.userId === user.id && d.id === normalizedDevice.deviceId && d.status !== 'removed');
    if (!device && user.role !== 'admin') return null;
    if (device) {
      device.lastSeenAt = nowIso();
      device.lastIp = normalizedDevice.ip || device.lastIp || '';
      device.userAgent = normalizedDevice.userAgent || device.userAgent || '';
      if (normalizedDevice.deviceName) device.deviceName = normalizedDevice.deviceName;
      saveStore(store);
    }
  }
  return { user: sanitizeUser(user, store), session: { createdAt: session.createdAt, expiresAt: session.expiresAt, deviceId: session.deviceId || '' } };
}

function logoutMember(token) {
  if (!token) return false;
  const store = loadStore();
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const before = store.sessions.length;
  store.sessions = store.sessions.filter(s => s.tokenHash !== tokenHash);
  saveStore(store);
  return store.sessions.length !== before;
}

function getMemberBootstrapInfo() {
  const store = loadStore();
  const admin = getUserByUsername(store, DEFAULT_ADMIN_USERNAME) || store.users[0];
  return {
    initialized: true,
    defaultUsername: admin?.username || DEFAULT_ADMIN_USERNAME,
    hasUsers: store.users.length > 0,
    title: '拾柒專屬追蹤系統',
    memberDeviceLimit: DEFAULT_DEVICE_LIMIT
  };
}

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new Error('需要管理員權限');
}

function listMembers() {
  const store = loadStore();
  return store.users.map(user => sanitizeUser(user, store)).sort((a, b) => String(a.username).localeCompare(String(b.username), 'zh-Hant'));
}


function normalizeDeviceLimit(value, fallback = DEFAULT_DEVICE_LIMIT, role = 'member') {
  if (role === 'admin') return 99;
  const n = Number(value);
  if (ALLOWED_DEVICE_LIMITS.includes(n)) return n;
  return fallback;
}

function createMember(payload = {}, adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '').trim();
  if (!username || !password) throw new Error('請輸入會員帳號與密碼');
  if (getUserByUsername(store, username)) throw new Error('此會員帳號已存在');
  const expiry = buildExpiry(payload.planType, payload.durationDays);
  const member = {
    id: randomId('u'),
    username,
    displayName: String(payload.displayName || username).trim(),
    role: payload.role === 'admin' ? 'admin' : 'member',
    password: makePasswordRecord(password),
    status: payload.status === 'disabled' ? 'disabled' : 'active',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    note: String(payload.note || '').trim(),
    accessLevel: payload.role === 'admin' ? 'vip' : (String(payload.accessLevel || '').toLowerCase() === 'vip' ? 'vip' : 'normal'),
    deviceLimit: normalizeDeviceLimit(payload.deviceLimit, DEFAULT_DEVICE_LIMIT, payload.role === 'admin' ? 'admin' : 'member'),
    ...expiry,
    accessKeyId: String(payload.accessKeyId || '').trim()
  };
  store.users.push(member);
  addAdminLog(store, adminUser, '新增會員', username, `方案:${member.planType} 到期:${member.expiresAt}`);
  saveStore(store);
  return sanitizeUser(member, store);
}

function updateMember(memberId, payload = {}, adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  const member = store.users.find(u => u.id === memberId);
  if (!member) throw new Error('找不到會員');
  if (payload.displayName !== undefined) member.displayName = String(payload.displayName || '').trim() || member.username;
  if (payload.note !== undefined) member.note = String(payload.note || '').trim();
  if (payload.role !== undefined && member.username !== DEFAULT_ADMIN_USERNAME) member.role = payload.role === 'admin' ? 'admin' : 'member';
  if (payload.accessLevel !== undefined) member.accessLevel = String(payload.accessLevel || '').toLowerCase() === 'vip' ? 'vip' : 'normal';
  if (payload.deviceLimit !== undefined) member.deviceLimit = normalizeDeviceLimit(payload.deviceLimit, Number(member.deviceLimit || DEFAULT_DEVICE_LIMIT), member.role);
  if (payload.status !== undefined) {
    member.status = payload.status === 'disabled' ? 'disabled' : 'active';
    if (member.status === 'disabled') {
      store.sessions = store.sessions.filter(s => s.userId !== member.id);
    }
  }
  if (payload.planType || payload.durationDays || payload.expiresAt) {
    if (payload.expiresAt) {
      member.expiresAt = new Date(payload.expiresAt).toISOString();
      member.planType = String(payload.planType || member.planType || 'custom');
      member.durationDays = Number(payload.durationDays || member.durationDays || 0);
    } else {
      Object.assign(member, buildExpiry(payload.planType, payload.durationDays));
    }
  }
  if (payload.password) member.password = makePasswordRecord(String(payload.password));
  member.updatedAt = nowIso();
  addAdminLog(store, adminUser, '更新會員', member.username, `狀態:${member.status} 方案:${member.planType} 等級:${member.accessLevel || 'normal'} 設備上限:${member.deviceLimit || DEFAULT_DEVICE_LIMIT}`);
  saveStore(store);
  return sanitizeUser(member, store);
}

function extendMember(memberId, payload = {}, adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  const member = store.users.find(u => u.id === memberId);
  if (!member) throw new Error('找不到會員');
  Object.assign(member, buildExpiry(payload.planType || member.planType || 'month', payload.durationDays, member.expiresAt));
  member.updatedAt = nowIso();
  addAdminLog(store, adminUser, '會員續期', member.username, `方案:${member.planType} 到期:${member.expiresAt}`);
  saveStore(store);
  return sanitizeUser(member, store);
}

function listMemberDevices(memberId, adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  const member = store.users.find(u => u.id === memberId);
  if (!member) throw new Error('找不到會員');
  return getUserDevices(store, member.id);
}

function removeMemberDevice(memberId, deviceId, adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  const member = store.users.find(u => u.id === memberId);
  if (!member) throw new Error('找不到會員');
  const before = store.devices.length;
  store.devices = store.devices.filter(d => !(d.userId === member.id && d.id === deviceId));
  store.sessions = store.sessions.filter(s => !(s.userId === member.id && s.deviceId === deviceId));
  if (before === store.devices.length) throw new Error('找不到綁定設備');
  addAdminLog(store, adminUser, '移除設備', member.username, `設備:${deviceId}`);
  saveStore(store);
  return getUserDevices(store, member.id);
}

function clearMemberDevices(memberId, adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  const member = store.users.find(u => u.id === memberId);
  if (!member) throw new Error('找不到會員');
  store.devices = store.devices.filter(d => d.userId !== member.id);
  store.sessions = store.sessions.filter(s => s.userId !== member.id);
  addAdminLog(store, adminUser, '清空設備', member.username, '清空此會員全部設備');
  saveStore(store);
  return [];
}

function generateAccessKeys(payload = {}, adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  const count = Math.max(1, Math.min(200, Number(payload.count || 1)));
  const { planType, durationDays } = normalizePlan(payload.planType, payload.durationDays);
  const prefix = String(payload.prefix || 'SVN').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'SVN';
  const created = [];
  for (let i = 0; i < count; i++) {
    const item = {
      id: randomId('k'),
      code: makeAccessKeyString(prefix),
      planType,
      durationDays,
      status: 'unused',
      note: String(payload.note || '').trim(),
      createdAt: nowIso(),
      createdBy: adminUser?.username || 'system',
      usedAt: '',
      usedBy: ''
    };
    store.accessKeys.unshift(item);
    created.push(sanitizeKey(item));
  }
  addAdminLog(store, adminUser, '生成金鑰', '', `數量:${count} 方案:${planType}`);
  saveStore(store);
  return created;
}

function listAccessKeys() {
  const store = loadStore();
  return store.accessKeys.map(sanitizeKey);
}

function redeemAccessKey(code, targetUserId, adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  const key = store.accessKeys.find(k => String(k.code).trim().toUpperCase() === String(code || '').trim().toUpperCase());
  if (!key) throw new Error('找不到金鑰');
  if (key.status !== 'unused') throw new Error('此金鑰已被使用或停用');
  const member = store.users.find(u => u.id === targetUserId);
  if (!member) throw new Error('找不到會員');
  Object.assign(member, buildExpiry(key.planType, key.durationDays, member.expiresAt));
  member.accessKeyId = key.id;
  member.updatedAt = nowIso();
  key.status = 'used';
  key.usedAt = nowIso();
  key.usedBy = member.username;
  addAdminLog(store, adminUser, '套用金鑰', member.username, `金鑰:${key.code}`);
  saveStore(store);
  return { member: sanitizeUser(member, store), key: sanitizeKey(key) };
}


function renameMemberDevice(memberId, deviceId, deviceName, adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  const member = store.users.find(u => u.id === memberId);
  if (!member) throw new Error('找不到會員');
  const device = store.devices.find(d => d.userId === member.id && d.id === deviceId && d.status !== 'removed');
  if (!device) throw new Error('找不到綁定設備');
  device.deviceName = String(deviceName || '').trim().slice(0, 120) || device.deviceName || '未知設備';
  addAdminLog(store, adminUser, '設備改名', member.username, `設備:${device.id} 名稱:${device.deviceName}`);
  saveStore(store);
  return getUserDevices(store, member.id);
}

function listAdminLogs(adminUser) {
  requireAdmin(adminUser);
  const store = loadStore();
  return (store.adminLogs || []).map(sanitizeAdminLog);
}

function describeLoginSource(ip = '') {
  return describeIp(ip);
}

module.exports = {
  loginMember,
  findUserByToken,
  logoutMember,
  getMemberBootstrapInfo,
  listMembers,
  createMember,
  updateMember,
  extendMember,
  listMemberDevices,
  removeMemberDevice,
  clearMemberDevices,
  renameMemberDevice,
  generateAccessKeys,
  listAccessKeys,
  redeemAccessKey,
  listAdminLogs,
  describeLoginSource
};
