/**
 * ip-guard.js — تسجيل تلقائي ومستمر لعنوان IP الصادر لدى منصة Nexus.
 *
 * المشكلة: خطة Render المجانية تُخرج الاتصالات عبر أحد عناوين نطاقين ثابتين
 * (74.220.48.0/24 و 74.220.56.0/24 لمنطقة Oregon حالياً)، وليس عنواناً واحداً
 * دائماً. منصة Nexus تتطلب أن يكون عنوان IP الفعلي الصادر مسجّلاً في قائمتها
 * البيضاء (Cloudflare) — تسجيل يدوي مرة واحدة غير كافٍ لأن العنوان قد يتغيّر
 * بين عناوين النطاق عند كل إعادة نشر/تشغيل.
 *
 * الحل: عند إقلاع الخادم (وكل ساعة تلقائياً)، يسجّل هذا الملف الدخول بحساب
 * لوحة التحكم (نفس بيانات AGENT_CODE المستخدمة أو حساب Master مثل test_demo)
 * ثم يكتشف عنوان IP الصادر الحالي ويضيفه لقائمة /api/whitelist عبر
 * /api/whitelist/add — تلقائياً وبدون أي تدخل يدوي أو بروكسي أو تكلفة.
 *
 * متغيرات البيئة المطلوبة (تُضبط في Render → Environment):
 *   OFFICE_LOGIN     — كود الدخول للوحة التحكم (مثال: test_demo)
 *   OFFICE_PASSWORD  — كلمة مرور نفس الحساب
 *   OFFICE_API       — رابط اللوحة (افتراضياً https://my.nexusggr.dev، موجود أصلاً)
 */
const OFFICE_API = process.env.OFFICE_API || 'https://my.nexusggr.dev';
const LOGIN = process.env.OFFICE_LOGIN || process.env.AGENT_CODE || '';
const PASSWORD = process.env.OFFICE_PASSWORD || process.env.AGENT_PASSWORD || '';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // كل ساعة
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0';

let lastRegisteredIp = null;

function extractCookie(setCookieHeader) {
  return (setCookieHeader || '')
    .split(/,(?=\s*[A-Za-z0-9_]+=)/)
    .map((part) => {
      const m = part.match(/([A-Za-z0-9_]+)=([^;]+)/);
      return m ? `${m[1]}=${m[2]}` : null;
    })
    .filter(Boolean)
    .join('; ');
}

async function officeLogin() {
  const res = await fetch(`${OFFICE_API}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ loginCode: LOGIN, password: PASSWORD }).toString(),
  });
  const cookie = extractCookie(res.headers.get('set-cookie'));
  const data = await res.json().catch(() => ({}));
  if (data.status !== 1) throw new Error('office login failed: ' + (data.msg || 'unknown'));
  return cookie;
}

async function currentOutboundIp() {
  // خدمة بسيطة وسريعة لمعرفة عنوان IP الصادر الحالي لخادمنا
  const res = await fetch('https://api.ipify.org?format=json');
  const data = await res.json();
  return data.ip;
}

async function whitelistContains(cookie, ip) {
  const res = await fetch(`${OFFICE_API}/api/whitelist/all`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ search: ip, dir: 'desc', order: 'createdAt', draw: '1', start: '0', length: '5' }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.data) && data.data.some((row) => row.ip === ip);
}

async function addToWhitelist(cookie, ip) {
  const res = await fetch(`${OFFICE_API}/api/whitelist/add`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${OFFICE_API}/app/cloudflare`,
      'User-Agent': UA,
    },
    body: new URLSearchParams({ agentCode: LOGIN, ip }).toString(),
  });
  return res.json().catch(() => ({}));
}

/** يتحقق من عنوان IP الحالي ويسجّله في القائمة البيضاء إذا لم يكن مسجّلاً بعد. */
async function ensureIpWhitelisted() {
  if (!LOGIN || !PASSWORD) {
    console.warn('[ip-guard] OFFICE_LOGIN/OFFICE_PASSWORD غير مضبوطين — تخطي التسجيل التلقائي للـ IP.');
    return { skipped: true };
  }
  try {
    const ip = await currentOutboundIp();
    if (ip === lastRegisteredIp) return { ok: true, ip, alreadyChecked: true };

    const cookie = await officeLogin();
    const exists = await whitelistContains(cookie, ip);
    if (exists) {
      lastRegisteredIp = ip;
      console.log(`[ip-guard] العنوان ${ip} مسجّل بالفعل في القائمة البيضاء ✅`);
      return { ok: true, ip, alreadyListed: true };
    }
    const r = await addToWhitelist(cookie, ip);
    if (r.status === 1) {
      lastRegisteredIp = ip;
      console.log(`[ip-guard] تمت إضافة العنوان الجديد ${ip} إلى القائمة البيضاء تلقائياً ✅`);
      return { ok: true, ip, added: true };
    }
    console.error(`[ip-guard] فشل تسجيل العنوان ${ip}:`, r.msg || r);
    return { ok: false, ip, error: r.msg || 'unknown' };
  } catch (err) {
    console.error('[ip-guard] خطأ أثناء التحقق من القائمة البيضاء:', err.message);
    return { ok: false, error: err.message };
  }
}

/** يبدأ الفحص الدوري (عند الإقلاع مباشرة، ثم كل ساعة). */
function startAutoIpGuard() {
  ensureIpWhitelisted();
  setInterval(ensureIpWhitelisted, CHECK_INTERVAL_MS);
}

module.exports = { ensureIpWhitelisted, startAutoIpGuard };
