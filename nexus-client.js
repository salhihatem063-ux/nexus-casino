/**
 * nexus-client.js — عميل التكامل مع منصة Nexus GGR.
 *
 * يقسم إلى جزأين:
 *
 * 1) OfficeClient  — يتصل بلوحة التحكم (my.nexusggr.dev) بجلسة تسجيل دخول.
 *    مؤكّد ومختبَر: تسجيل الدخول، أرصدة الوكلاء، معاملات الألعاب، إلخ.
 *
 * 2) GameClient    — تكامل اللعب برصيدكم (TRANSFER / SEAMLESS).
 *    يوقّع كل طلب بـ token + secretKey ببصمة MD5/SHA256.
 *    ⚠️ رابط Game API النهائي وأسماء الحقول تُسلَّم من المورّد عند تفعيل
 *      الحساب الإنتاجي (القيم أدناه هي القالب المعياري — اضبطها على الدليل).
 *
 * لا يعتمد على أي مكتبة خارجية.
 */

const crypto = require('crypto');

// ------------------ أدوات ------------------

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}
function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function hmacSha256(key, s) {
  return crypto.createHmac('sha256', key).update(s, 'utf8').digest('hex');
}

/**
 * بصمة التوقيع المعيارية لأنظمة Nexus:
 *  1) تُجمع الحقول باستثناء sign/secretKey
 *  2) تُرتّب أبجدياً: key1=v1&key2=v2 ...
 *  3) يُلصق secretKey في النهاية
 *  4) بصمة MD5
 * بدّل signMode في الإعداد إلى 'sha256' أو 'hmac' إذا طلب المورّد غير ذلك.
 */
function buildSignature(params, secretKey, mode = 'md5') {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'secretKey' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  const base = keys.map((k) => `${k}=${params[k]}`).join('&') + secretKey;
  if (mode === 'sha256') return sha256(base);
  return md5(base);
}

async function formPost(url, params, headers = {}) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0',
      ...headers,
    },
    body,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0',
      ...headers,
    },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

// ============================================================
// 1) عميل لوحة التحكم (جلسة login) — مؤكّد ومختبَر
// ============================================================
class OfficeClient {
  constructor(officeApiBase) {
    this.base = officeApiBase.replace(/\/$/, '');
    this.cookie = '';
  }

  async login(loginCode, password) {
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0',
      },
      body: new URLSearchParams({ loginCode, password }).toString(),
    });
    const setCookie = res.headers.get('set-cookie') || '';
    // استخراج كل أزواج name=value من ترويسة set-cookie (الجلسة هنا اسمها _gid)
    this.cookie = setCookie
      .split(/,(?=\s*[A-Za-z0-9_]+=)/)
      .map((part) => {
        const m = part.match(/([A-Za-z0-9_]+)=([^;]+)/);
        return m ? `${m[1]}=${m[2]}` : null;
      })
      .filter(Boolean)
      .join('; ');
    const data = await res.json();
    if (data.status !== 1) throw new Error('login failed: ' + (data.msg || JSON.stringify(data)));
    return data;
  }

  _h(extra = {}) {
    return {
      Cookie: this.cookie,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${this.base}/app/dashboard`,
      ...extra,
    };
  }

  /** الرصيد اللحظي (وكيل + مستخدمون) */
  async realtime() {
    return getJson(`${this.base}/api/realtime`, this._h());
  }

  /** شجرة الوكلاء — منها يُقرأ token/secretKey/siteEndPoint/apiType/balance */
  async agentChilds() {
    return getJson(`${this.base}/api/agent/childs`, this._h());
  }

  /** معاملات الألعاب (DataTables: draw/start/length) */
  async gameTransactions(start = 0, length = 50) {
    return getJson(
      `${this.base}/api/game_transaction?draw=1&start=${start}&length=${length}`,
      this._h({ Referer: `${this.base}/app/live_game_transaction` })
    );
  }
}

// ============================================================
// 2) عميل اللعب — وفق التوثيق الرسمي ggr.gitbook.io
//    POST https://api.{domain}/  بجسم JSON يحوي حقل method
//    المصادقة: agent_code + agent_token (لا يوجد MD5 على Game API؛
//    الـ secretKey يُستخدم لتوقيع نداءات SEAMLESS فقط).
// ============================================================
class GameClient {
  constructor({ gameApiBase, agentCode, token, secretKey, currency = 'UAH' }) {
    // القاعدة: https://api.nexusggr.dev  (تُبنى من host اللوحة: api. + domain)
    this.base = gameApiBase.replace(/\/$/, '');
    this.agentCode = agentCode;
    this.token = token;
    this.secret = secretKey;
    this.currency = currency;
  }

  async _call(method, extra = {}) {
    const body = {
      method,
      agent_code: this.agentCode,
      agent_token: this.token,
      ...extra,
    };
    const res = await fetch(`${this.base}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { status: 0, raw: text.slice(0, 200), httpStatus: res.status }; }
  }

  /** إضافة رصيد للاعب من رصيد الوكيل (رصيدكم) — يبدأ اللاعب بـ 0 وتضيف له أنت */
  depositUser({ userCode, amount, sign }) {
    return this._call('user_deposit', {
      user_code: userCode, amount: Number(amount), agent_sign: sign || `dep_${Date.now()}`,
    });
  }

  /** سحب من رصيد اللاعب إلى رصيد الوكيل */
  withdrawUser({ userCode, amount, sign }) {
    return this._call('user_withdraw', {
      user_code: userCode, amount: Number(amount), agent_sign: sign || `wd_${Date.now()}`,
    });
  }

  /** تصفير رصيد اللاعب وإعادة كامل المبلغ المتبقي للوكيل بعد الجلسة */
  resetUser({ userCode, allUsers = false }) {
    return this._call('user_withdraw_reset', allUsers ? { all_users: true } : { user_code: userCode });
  }

  /** قائمة المزودين المخصصين للوكيل (مختبَر ✅) */
  providerList() {
    return this._call('provider_list');
  }

  /** قائمة ألعاب مزود معيّن (مختبَر ✅) */
  gameList({ providerCode }) {
    return this._call('game_list', { provider_code: providerCode });
  }

  /**
   * رصيد الوكيل ورصيد لاعب (money_info — مختبَر ✅).
   * لاعب جديد يرجع user={} أي رصيده 0/غير موجود.
   */
  moneyInfo({ userCode } = {}) {
    const p = userCode ? { user_code: userCode } : {};
    return this._call('money_info', p);
  }

  /**
   * إطلاق لعبة — يعيد launch_url (مختبَر ✅).
   * في وضع TRANSFER يلزم إيداع سابق (user_deposit) ليتمكن اللاعب من الدوران؛
   * اللاعب برصيد 0 تُفتح اللعبة لكن الرهان يُرفض بـ INSUFFICIENT_USER_FUNDS.
   */
  launchGame({ userCode, providerCode, gameCode, lang = 'en', rtp, lobbyUrl, live = false }) {
    const payload = {
      user_code: userCode,
      provider_code: providerCode,
      lang,
    };
    // lobby_url فارغ = "Invalid Parameter" من المزوّد — نرسله فقط إن كان رابطاً صالحاً
    if (lobbyUrl && /^https?:\/\//.test(lobbyUrl)) payload.lobby_url = lobbyUrl;
    // game_code صريح فقط إن وُجد (اللايف يُطلق بدونه لفتح اللوبي)
    if (gameCode && String(gameCode).trim() !== '') payload.game_code = gameCode;
    if (rtp) payload.rtp = rtp;
    return this._call('game_launch', payload);
  }
}

// ============================================================
// 3) خادم محفظتكم المحلي (SEAMLESS): يقبل نداءات الرهان/الربح
//     يستدعيه المورّد في وضع SEAMLESS (المصرّف لكم أيضاً).
// ============================================================
/**
 * للوضع SEAMLESS يركّب المورّد رابط خادمك في `update_site_endpoint`،
 * ويستدعيه بتوقيع (يُتحقق بـ verifyCallbackSignature). هذه دالة المساعدة:
 */
function verifyCallbackSignature(rawBody, providedSign, secretKey, mode = 'md5') {
  let parsed = {};
  try { parsed = JSON.parse(rawBody); } catch { parsed = Object.fromEntries(new URLSearchParams(rawBody)); }
  const expected = buildSignature(parsed, secretKey, mode);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(providedSign)));
  } catch { return false; }
}

module.exports = {
  OfficeClient,
  GameClient,
  buildSignature,
  verifyCallbackSignature,
  md5, sha256, hmacSha256,
};
