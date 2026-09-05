/**
 * ledger.js — سجلّ محلي للحسابات (قاعدة بياناتكم).
 * مصدر قائمة الحسابات هو هذا الملف؛ الرصيد اللحظي لكل حساب يُجلب من Nexus (money_info).
 */
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'ledger-store.json');

const load = () => {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return { accounts: {} }; }
};
const save = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * إنشاء حساب لاعب. user_code هو المعرّف الذي يستخدمه اللاعب للدخول.
 * @returns {{created:boolean, code:string, account:object}}
 */
function createAccount(code, { label = '', password = '', currency = 'UAH' } = {}) {
  const d = load();
  code = String(code).trim();
  if (!code) throw new Error('كود الحساب مطلوب');
  if (d.accounts[code]) {
    return { created: false, code, account: d.accounts[code] };
  }
  d.accounts[code] = {
    code,
    label: label || code,
    password: password || '',
    currency,
    createdAt: Date.now(),
    tx: [],
  };
  save(d);
  return { created: true, code, account: d.accounts[code] };
}

function getAccount(code) {
  const d = load();
  return d.accounts[code] || null;
}

/** التحقق من دخول اللاعب: كود + كلمة مرور (إن وُجدت) */
function verifyLogin(code, password) {
  const a = getAccount(code);
  if (!a) return { ok: false, reason: 'الحساب غير موجود — أنشئه من لوحة الوكيل.' };
  if (a.password && a.password !== password) return { ok: false, reason: 'كلمة المرور غير صحيحة.' };
  return { ok: true, account: { code: a.code, label: a.label } };
}

/** قائمة الحسابات */
function listAccounts() {
  const d = load();
  return Object.values(d.accounts)
    .map((a) => ({ code: a.code, label: a.label, hasPassword: !!a.password, currency: a.currency, createdAt: a.createdAt }))
    .sort((x, y) => y.createdAt - x.createdAt);
}

/** سجل عملية (إيداع/سحب) على حساب */
function logTx(code, type, amount) {
  const d = load();
  if (!d.accounts[code]) return;
  d.accounts[code].tx = d.accounts[code].tx || [];
  d.accounts[code].tx.push({ type, amount: r2(amount), ts: Date.now() });
  save(d);
}

module.exports = {
  createAccount, getAccount, verifyLogin, listAccounts, logTx,
  // توافق خلفي للكود القديم:
  createPlayer: (c, cur) => createAccount(c, { currency: cur }),
};
