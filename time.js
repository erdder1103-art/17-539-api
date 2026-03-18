const TZ = 'Asia/Taipei';

function getTaipeiDate(base = new Date()) {
  return new Date(base.toLocaleString('en-US', { timeZone: TZ }));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTaipeiDateTime(base = new Date()) {
  const d = getTaipeiDate(base);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatTaipeiCompact(base = new Date()) {
  const d = getTaipeiDate(base);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function getTaipeiWeekday() {
  const map = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return map[getTaipeiDate().getDay()];
}

function getTaipeiNowIso() {
  const d = getTaipeiDate();
  return new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString();
}

module.exports = {
  TZ,
  getTaipeiDate,
  formatTaipeiDateTime,
  formatTaipeiCompact,
  getTaipeiWeekday,
  getTaipeiNowIso
};
